import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export function createMemoryBlobStore<T>() {
  const values = new Map<string, PluginBlobEntry<T>>();
  const register = async (
    key: string,
    bytes: Uint8Array,
    metadata: T,
    opts?: { ttlMs?: number },
  ) => {
    values.set(key, {
      key,
      bytes,
      metadata,
      sizeBytes: bytes.byteLength,
      createdAt: Date.now(),
      ...(opts?.ttlMs ? { expiresAt: Date.now() + opts.ttlMs } : {}),
    });
  };
  return {
    register,
    async registerIfAbsent(key: string, bytes: Uint8Array, metadata: T, opts?: { ttlMs?: number }) {
      if (values.has(key)) {
        return false;
      }
      await register(key, bytes, metadata, opts);
      return true;
    },
    async lookup(key: string) {
      return values.get(key);
    },
    async entries() {
      return [...values.values()].map(({ bytes: _bytes, ...entry }) => entry);
    },
    async delete(key: string) {
      return values.delete(key);
    },
    async deleteExpiredKey(key: string) {
      const entry = values.get(key);
      if (!entry?.expiresAt || entry.expiresAt > Date.now()) {
        return undefined;
      }
      values.delete(key);
      const { bytes: _bytes, ...info } = entry;
      return info;
    },
    async deleteExpired() {
      const expired: PluginBlobEntryInfo<T>[] = [];
      for (const key of values.keys()) {
        const entry = values.get(key);
        if (!entry?.expiresAt || entry.expiresAt > Date.now()) {
          continue;
        }
        values.delete(key);
        const { bytes: _bytes, ...info } = entry;
        expired.push(info);
      }
      return expired;
    },
    async clear() {
      values.clear();
    },
  };
}
