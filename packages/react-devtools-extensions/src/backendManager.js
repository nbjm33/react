/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  DevToolsHook,
  ReactRenderer,
} from 'react-devtools-shared/src/backend/types';
import {hasAssignedBackend} from 'react-devtools-shared/src/backend/utils';
import {COMPACT_VERSION_NAME} from './utils';

let welcomeHasInitialized = false;

// $FlowFixMe[missing-local-annot]
function welcome(event: $FlowFixMe) {
  if (
    event.source !== window ||
    event.data.source !== 'react-devtools-content-script'
  ) {
    return;
  }

  // In some circumstances, this method is called more than once for a single welcome message.
  // The exact circumstances of this are unclear, though it seems related to 3rd party event batching code.
  //
  // Regardless, call this method multiple times can cause DevTools to add duplicate elements to the Store
  // (and throw an error) or worse yet, choke up entirely and freeze the browser.
  //
  // The simplest solution is to ignore the duplicate events.
  // To be clear, this SHOULD NOT BE NECESSARY, since we remove the event handler below.
  //
  // See https://github.com/facebook/react/issues/24162
  if (welcomeHasInitialized) {
    console.warn(
      'React DevTools detected duplicate welcome "message" events from the content script.',
    );
    return;
  }

  welcomeHasInitialized = true;

  window.removeEventListener('message', welcome);

  setup(window.__REACT_DEVTOOLS_GLOBAL_HOOK__);
}

window.addEventListener('message', welcome);

function setup(hook: ?DevToolsHook) {
  // this should not happen, but Chrome can be weird sometimes
  if (hook == null) {
    return;
  }

  // register renderers that have already injected themselves.
  hook.renderers.forEach(renderer => {
    registerRenderer(renderer);
  });

  // Activate and remove from required all present backends, registered within the hook
  hook.backends.forEach((_, backendVersion) => {
    requiredBackends.delete(backendVersion);
    activateBackend(backendVersion, hook);
  });

  updateRequiredBackends();

  // register renderers that inject themselves later.
  hook.sub('renderer', ({renderer}) => {
    registerRenderer(renderer);
    updateRequiredBackends();
  });

  // listen for backend installations.
  hook.sub('devtools-backend-installed', version => {
    activateBackend(version, hook);
    updateRequiredBackends();
  });
}

const requiredBackends = new Set<string>();

function registerRenderer(renderer: ReactRenderer) {
  let version = renderer.reconcilerVersion || renderer.version;
  if (!hasAssignedBackend(version)) {
    version = COMPACT_VERSION_NAME;
  }
  requiredBackends.add(version);
}

function activateBackend(version: string, hook: DevToolsHook) {
  const backend = hook.backends.get(version);
  if (!backend) {
    throw new Error(`Could not find backend for version "${version}"`);
  }
  const {Agent, Bridge, initBackend, setupNativeStyleEditor} = backend;
  const bridge = new Bridge({
    listen(fn) {
      const listener = (event: $FlowFixMe) => {
        if (
          event.source !== window ||
          !event.data ||
          event.data.source !== 'react-devtools-content-script' ||
          !event.data.payload
        ) {
          return;
        }
        fn(event.data.payload);
      };
      window.addEventListener('message', listener);
      return () => {
        window.removeEventListener('message', listener);
      };
    },
    send(event: string, payload: any, transferable?: Array<any>) {
      window.postMessage(
        {
          source: 'react-devtools-bridge',
          payload: {event, payload},
        },
        '*',
        transferable,
      );
    },
  });

  const agent = new Agent(bridge);
  agent.addListener('shutdown', () => {
    // If we received 'shutdown' from `agent`, we assume the `bridge` is already shutting down,
    // and that caused the 'shutdown' event on the `agent`, so we don't need to call `bridge.shutdown()` here.
    hook.emit('shutdown');
  });

  initBackend(hook, agent, window);

  // Setup React Native style editor if a renderer like react-native-web has injected it.
  if (typeof setupNativeStyleEditor === 'function' && hook.resolveRNStyle) {
    setupNativeStyleEditor(
      bridge,
      agent,
      hook.resolveRNStyle,
      hook.nativeStyleEditorValidAttributes,
    );
  }

  // Let the frontend know that the backend has attached listeners and is ready for messages.
  // This covers the case of syncing saved values after reloading/navigating while DevTools remain open.
  bridge.send('extensionBackendInitialized');

  // this backend is activated
  requiredBackends.delete(version);
}

// tell the service worker which versions of backends are needed for the current page
function updateRequiredBackends() {
  window.postMessage(
    {
      source: 'react-devtools-backend-manager',
      payload: {
        type: 'react-devtools-required-backends',
        versions: Array.from(requiredBackends),
      },
    },
    '*',
  );
}
