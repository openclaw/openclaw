import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export function createDiscussionMemoryStore<T>(): PluginStateSyncKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    register: (key, value) => void values.set(key, { value, createdAt: Date.now() }),
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    lookup: (key) => values.get(key)?.value,
    consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () =>
      Array.from(values, ([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      })),
    clear: () => values.clear(),
  };
}
