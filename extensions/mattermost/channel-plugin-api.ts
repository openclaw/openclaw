import { loadBundledEntryExportSync } from "openclaw/plugin-sdk/channel-entry-contract";

type ChannelPluginModule = typeof import("./channel-plugin-runtime.js");

function createLazyObjectValue<T extends object>(load: () => T): T {
  return new Proxy({} as T, {
    get(_target, property, receiver) {
      return Reflect.get(load(), property, receiver);
    },
    has(_target, property) {
      return property in load();
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(load(), property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

function loadChannelPluginModule(): ChannelPluginModule {
  return loadBundledEntryExportSync<ChannelPluginModule>(import.meta.url, {
    specifier: "./channel-plugin-runtime.js",
  });
}

// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag the broader Mattermost helper surfaces into lightweight plugin loads.
export const mattermostPlugin: ChannelPluginModule["mattermostPlugin"] = createLazyObjectValue(
  () => loadChannelPluginModule().mattermostPlugin as object,
) as ChannelPluginModule["mattermostPlugin"];
