export type KeyedStoreEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};

export type KeyedStore<T> = {
  register(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<KeyedStoreEntry<T>[]>;
};

export function createMemoryKeyedStore<T>(): KeyedStore<T> {
  const entries = new Map<string, KeyedStoreEntry<T>>();

  function pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt != null && entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    async register(key, value, opts) {
      const now = Date.now();
      entries.set(key, {
        key,
        value,
        createdAt: now,
        ...(opts?.ttlMs != null ? { expiresAt: now + opts.ttlMs } : {}),
      });
    },
    async lookup(key) {
      pruneExpired();
      return entries.get(key)?.value;
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      pruneExpired();
      return Array.from(entries.values()).toSorted((a, b) => a.createdAt - b.createdAt);
    },
  };
}
