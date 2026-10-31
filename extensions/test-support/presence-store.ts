import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export function createPresenceStore(values = new Map<string, number>()) {
  return {
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: async (key) => values.get(key),
    consume: async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    deleteIfEqual: async (key, expected) => values.get(key) === expected && values.delete(key),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: value })),
    clear: async () => values.clear(),
  } satisfies PluginStateKeyedStore<number>;
}
