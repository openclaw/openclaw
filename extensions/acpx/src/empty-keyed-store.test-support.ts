import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export function createEmptyAcpxKeyedStore<T>(): PluginStateKeyedStore<T, 2> {
  return {
    lookup: async () => undefined,
    lookupMany: async (keys) => keys.map(() => ({ ok: true, value: undefined })),
    observe: async () => {
      throw new Error("The empty ACPX store does not support comparisons");
    },
    compareAndApply: async () => {
      throw new Error("The empty ACPX store does not support comparisons");
    },
    register: async () => {},
    registerIfAbsent: async () => true,
    entries: async () => [],
    entriesInKeyRange: async () => [],
    count: async () => 0,
    moveEntriesFrom: async () => {
      throw new Error("The empty ACPX store does not support namespace moves");
    },
    consume: async () => undefined,
    delete: async () => false,
    deleteIfEqual: async () => false,
    clear: async () => {},
  };
}
