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
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > maxBytes) {
      pushChunk(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) {
    pushChunk(current);
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
    nextChunkKeys: Set<string>;
  },
  chunkKeyPrefix: string,
): Promise<void> {
  for (const row of rows.chunks) {
    await store.register(row.key, row.value);
  }
  await store.register(rows.meta.key, rows.meta.value);
  for (const row of await store.entries()) {
    if (row.key.startsWith(chunkKeyPrefix) && !rows.nextChunkKeys.has(row.key)) {
      await store.delete(row.key);
    }
  }
}
