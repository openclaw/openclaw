import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  isPostgresSqlConnection,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { readMemoryPublishedVectorMeta } from "./manager-rebuild-embeddings.js";
import type { MemoryIndexProviderIdentity } from "./manager-reindex-state.js";

/** Rows examined per write transaction; callers yield between pages. */
const MEMORY_EMBEDDING_CACHE_RETIRE_PAGE = 256;

export type MemoryEmbeddingCacheRetireCursor = { updatedAt: number; hash: string };

/** Each pass is fenced to one side of a run's start. */
export type MemoryEmbeddingCacheRetireFence =
  /** Only rows this run wrote: a failed or concurrent run's earlier rows stay reusable. */
  | { writtenSince: number; writtenBefore?: never }
  /** Existing rows after a full rebuild: rows written while it ran stay with the first fence. */
  | { writtenBefore: number; writtenSince?: never };

export type MemoryEmbeddingCacheRetirement = MemoryEmbeddingCacheRetireFence & {
  identity: MemoryIndexProviderIdentity;
  after?: MemoryEmbeddingCacheRetireCursor;
};

type RetireDatabase = {
  memory_embedding_cache: {
    provider: string;
    model: string;
    provider_key: string;
    hash: string;
    embedding: Uint8Array;
    updated_at: number;
  };
  memory_index_chunks: {
    hash: string;
    source: MemorySource;
    model: string;
    embedding: Uint8Array;
  };
};

/**
 * Delete one page of cache rows whose vector the published memory index already holds.
 * A row goes only when every published chunk carrying its hash holds the same bytes and
 * at least one of them is a memory-file chunk under the bound identity, so published
 * read-through can serve that file again. Rows whose vector differs from any published
 * variant, or whose hash is unpublished or session-only, are kept.
 */
export function retirePublishedMemoryEmbeddingCacheRows(
  database: EngineConnection,
  input: MemoryEmbeddingCacheRetirement,
): { removed: number; next?: MemoryEmbeddingCacheRetireCursor } {
  const { identity } = input;
  const published = readMemoryPublishedVectorMeta(database, [identity]);
  if (!published || published.meta.model !== identity.model) {
    return { removed: 0 };
  }
  const db = getNodeSqliteKysely<RetireDatabase>(database);
  const postgres = isPostgresSqlConnection(database);
  const { after } = input;
  const page = db
    .selectFrom("memory_embedding_cache")
    .select(["hash", "embedding", "updated_at"])
    .where((eb) => {
      // SQLite only: the no-op TEXT cast keeps the planner on the updated_at index.
      const key = (column: "provider" | "model" | "provider_key") =>
        postgres ? eb.ref(column) : eb.cast(column, "text");
      return eb.and([
        eb(key("provider"), "=", identity.provider),
        eb(key("model"), "=", identity.model),
        eb(key("provider_key"), "=", identity.providerKey),
        input.writtenBefore === undefined
          ? eb("updated_at", ">=", input.writtenSince)
          : eb("updated_at", "<", input.writtenBefore),
        // The redundant lower bound keeps one updated_at range; a bare OR keyset makes
        // SQLite sort every remaining row on each page.
        ...(after
          ? [
              eb("updated_at", ">=", after.updatedAt),
              eb.or([eb("updated_at", ">", after.updatedAt), eb("hash", ">", after.hash)]),
            ]
          : []),
      ]);
    })
    .orderBy("updated_at", "asc")
    .orderBy("hash", "asc")
    .limit(MEMORY_EMBEDDING_CACHE_RETIRE_PAGE);
  const candidates = [...iterateSqliteQuerySync(database, page)];
  if (candidates.length === 0) {
    return { removed: 0 };
  }
  const last = candidates.at(-1)!;
  const next =
    candidates.length === MEMORY_EMBEDDING_CACHE_RETIRE_PAGE
      ? { updatedAt: last.updated_at, hash: last.hash }
      : undefined;
  const expectedBytes = published.meta.vectorDims * 8;
  const bytesByHash = new Map<string, Uint8Array>();
  for (const candidate of candidates) {
    if (candidate.embedding.byteLength === expectedBytes) {
      bytesByHash.set(candidate.hash, candidate.embedding);
    }
  }
  // One chunk read per page; chunks have no hash index, so a per-row lookup would rescan.
  const servable = new Set<string>();
  const conflicting = new Set<string>();
  if (bytesByHash.size > 0) {
    const chunks = db
      .selectFrom("memory_index_chunks")
      .select(["hash", "source", "model", "embedding"])
      .where("hash", "in", [...bytesByHash.keys()]);
    for (const chunk of iterateSqliteQuerySync(database, chunks)) {
      const bytes = bytesByHash.get(chunk.hash);
      if (!bytes || Buffer.compare(bytes, chunk.embedding) !== 0) {
        conflicting.add(chunk.hash);
      } else if (chunk.source === "memory" && chunk.model === published.meta.model) {
        servable.add(chunk.hash);
      }
    }
  }
  const retired = [...servable].filter((hash) => !conflicting.has(hash));
  if (retired.length === 0) {
    return { removed: 0, next };
  }
  const result = executeSqliteQuerySync(
    database,
    db
      .deleteFrom("memory_embedding_cache")
      .where("provider", "=", identity.provider)
      .where("model", "=", identity.model)
      .where("provider_key", "=", identity.providerKey)
      .where("hash", "in", retired),
  );
  return { removed: Number(result.numAffectedRows), next };
}
