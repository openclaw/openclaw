import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import { memoryChunkRowId } from "./manager-source-index-kernel.js";
import type { MemoryIndexWorkItem, MemorySyncProviderGeneration } from "./manager-sync-ops.js";

export type PreparedMemoryIndexEntry = {
  entry: MemoryIndexWorkItem["entry"];
  source: MemorySource;
  /** Chunks to embed and write; a session delta leaves out retained chunks. */
  chunks: IndexedMemoryChunk[];
  /** Indexed session chunks whose rows publication keeps in place. */
  retained?: IndexedMemoryChunk[];
  structuredInputBytes?: number;
};

// Planning reads the current worker-owned index; publication revalidates the
// retained rows under its write lock before changing any indexed content.
export async function retainIndexedSessionChunks(
  prepared: PreparedMemoryIndexEntry,
  database: MemoryIndexDatabase,
  generation: MemorySyncProviderGeneration | null,
  assertCurrent: () => void,
): Promise<PreparedMemoryIndexEntry> {
  const { entry, source, chunks } = prepared;
  // A full reindex fills an empty shadow, which has no rows to retain.
  if (
    source !== "sessions" ||
    entry.kind === "multimodal" ||
    chunks.length === 0 ||
    database.isShadow
  ) {
    return prepared;
  }
  const indexed = await database.read(
    { type: "source.chunks", input: { source, path: entry.path } },
    assertCurrent,
  );
  // Rows without stored embeddings are rewritten once a provider is available.
  const semantic = generation?.kind === "semantic";
  const keep = new Set(indexed.filter((row) => row.embedded || !semantic).map((row) => row.id));
  if (keep.size === 0) {
    return prepared;
  }
  const model = generation?.provider?.model ?? "fts-only";
  const written: IndexedMemoryChunk[] = [];
  const retained: IndexedMemoryChunk[] = [];
  // Repeated transcript text yields identical rows under one id. Plan each id
  // once so a duplicate cannot rewrite the row this delta retains.
  const planned = new Set<string>();
  for (const chunk of chunks) {
    const id = memoryChunkRowId(source, entry.path, chunk, model);
    if (!planned.has(id)) {
      planned.add(id);
      (keep.has(id) ? retained : written).push(chunk);
    }
  }
  return retained.length > 0 ? { ...prepared, chunks: written, retained } : prepared;
}
