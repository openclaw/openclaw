import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function chunkMatrixStateJson(
  value: string,
  maxBytes: number,
  maxChunks: number,
  limitMessage: string,
): string[] {
  const chunks: string[] = [];
  const pushChunk = (chunk: string) => {
    if (chunks.length >= maxChunks) {
      throw new Error(limitMessage);
    }
    chunks.push(chunk);
  };
  let chunkStart = 0;
  let currentBytes = 0;
  // Slice whole code points instead of allocating and concatenating one string
  // per character. Crypto snapshots can contain millions of characters.
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const charBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (index > chunkStart && currentBytes + charBytes > maxBytes) {
      pushChunk(value.slice(chunkStart, index));
      chunkStart = index;
      currentBytes = 0;
    }
    currentBytes += charBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (chunkStart < value.length) {
    pushChunk(value.slice(chunkStart));
  }
  return chunks;
}

export async function readMatrixStateChunks<T>(
  store: Pick<PluginStateKeyedStore<T>, "lookup" | "lookupMany">,
  keys: string[],
  kind: string,
): Promise<string[] | null> {
  // lookupMany is optional on the published host floor.
  const records = await store.lookupMany?.(keys);
  const chunks: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const result = records?.[index];
    if (result && !result.ok) {
      throw result.error;
    }
    const chunk = records ? result?.value : await store.lookup(keys[index]!);
    if (
      !isRecord(chunk) ||
      chunk.kind !== kind ||
      chunk.index !== index ||
      typeof chunk.data !== "string"
    ) {
      return null;
    }
    chunks.push(chunk.data);
  }
  return chunks;
}

export async function writeMatrixStateChunks<T>(
  store: Pick<PluginStateKeyedStore<T>, "register" | "entries" | "delete">,
  rows: {
    chunks: { key: string; value: T }[];
    meta: { key: string; value: T };
  },
  chunkKeyPrefix: string,
): Promise<void> {
  const nextChunkKeys = new Set(rows.chunks.map((row) => row.key));
  for (const row of rows.chunks) {
    await store.register(row.key, row.value);
  }
  await store.register(rows.meta.key, rows.meta.value);
  for (const row of await store.entries()) {
    if (row.key.startsWith(chunkKeyPrefix) && !nextChunkKeys.has(row.key)) {
      await store.delete(row.key);
    }
  }
}
