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
  /** Retained chunks whose small metadata changed. */
  retained?: IndexedMemoryChunk[];
  /** Present for incremental replacement, including when no rows were removed. */
  removedIds?: string[];
  structuredInputBytes?: number;
};

/** A shadow's empty tombstone table cannot authorize publication into the live index. */
export async function assertMemorySessionNotForgotten(
  database: MemoryIndexDatabase,
  { agentId, sessionId }: { agentId: string; sessionId: string },
  assertCurrent: () => void,
): Promise<void> {
  // Callers may carry all source chunks; only identity belongs in this worker read.
  const predicate = await database.read(
    { type: "session.current", input: { agentId, sessionId } },
    assertCurrent,
  );
  assertCurrent();
  if (predicate === "forgotten") {
    throw new Error(
      "A session was forgotten while memory indexing was running; retry the memory index.",
    );
  }
}

// The index owner plans once; publication consumes the plan without rereading it.
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
  const keep = new Map(
    indexed.filter((row) => row.embedded || !semantic).map((row) => [row.id, row]),
  );
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
      const current = keep.get(id);
      if (!current) {
        written.push(chunk);
      } else if (
        current.importance !== chunk.importance ||
        current.triggers !== chunk.triggers ||
        current.projectKey !== chunk.projectKey ||
        current.originClass !== (chunk.provenance?.originClass ?? "untrusted") ||
        current.sessionKind !== (chunk.provenance?.sessionKind ?? "unknown") ||
        (chunk.provenance && current.observedAt !== chunk.provenance.observedAt) ||
        current.supersedesKey !== (chunk.provenance?.supersedesKey ?? null)
      ) {
        retained.push(chunk);
      }
    }
  }
  return {
    ...prepared,
    chunks: written,
    retained,
    removedIds: indexed.filter((row) => !planned.has(row.id)).map((row) => row.id),
  };
}
