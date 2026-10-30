import type { A2aTaskStore } from "./task-store.js";

export function createTerminalStoreFixture() {
  type Store = ConstructorParameters<typeof A2aTaskStore>[0];
  type Value = Parameters<Store["register"]>[1];
  const rows = new Map<string, { key: string; value: Value; createdAt: number }>();
  return {
    rows,
    async entries() {
      return structuredClone([...rows.values()]);
    },
    async register(this: void, key: string, value: Value) {
      rows.set(key, { key, value: structuredClone(value), createdAt: Date.now() });
      if (rows.size > 500) {
        rows.delete([...rows.keys()].toSorted()[0]!);
      }
    },
  } satisfies Store & { rows: typeof rows };
}
