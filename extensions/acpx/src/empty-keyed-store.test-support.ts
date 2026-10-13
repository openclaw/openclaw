import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export function createEmptyAcpxKeyedStore<T>(): PluginStateKeyedStore<T> {
  return {
    lookup: async () => undefined,
    register: async () => {},
    registerIfAbsent: async () => true,
    entries: async () => [],
    consume: async () => undefined,
    delete: async () => false,
    clear: async () => {},
  };
}
