import type { DatabaseSync } from "node:sqlite";
import {
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  type Generated,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { MemoryIndexProviderIdentity } from "./manager-reindex-state.js";

type MemoryEmbeddingCacheRow = {
  provider: string;
  model: string;
  provider_key: string;
  hash: string;
  embedding: Uint8Array;
  dims: number | null;
  updated_at: number;
};

type EmbeddingCacheDatabase = {
  memory_embedding_cache: MemoryEmbeddingCacheRow & { rowid: Generated<number> };
  memory_index_chunks: { hash: string; updated_at: number };
};

/**
 * Capacity eviction takes rows of these identities first when no published chunk
 * carries their hash and they were last written before the oldest published
 * chunk. A full reindex rewrites every chunk, so such a row predates the index
 * that dropped it; newer unreferenced rows, such as a retry's or another sync's
 * unpublished vectors, keep plain oldest-first order. The eviction count is
 * unchanged.
 */
export type MemoryEmbeddingCacheEvictionPreference = {
  identities: MemoryIndexProviderIdentity[];
};

/** Require a finite, nonempty vector compatible with the active embedding dimensions. */
export function isValidMemoryEmbedding(embedding: number[], dimensions?: number): boolean {
  return (
    Array.isArray(embedding) &&
    embedding.length > 0 &&
    (dimensions === undefined || embedding.length === dimensions) &&
    embedding.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

export function loadMemoryEmbeddingCache(params: {
  db: DatabaseSync;
  providerIdentities: MemoryIndexProviderIdentity[];
  hashes: string[];
}): Map<string, number[]> {
  if (params.providerIdentities.length === 0 || params.hashes.length === 0) {
    return new Map();
  }
  const unresolved = new Set(params.hashes.filter(Boolean));
  if (unresolved.size === 0) {
    return new Map();
  }

  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db);
  const out = new Map<string, number[]>();
  const batchSize = 400;
  for (const identity of params.providerIdentities) {
    if (unresolved.size === 0) {
      break;
    }
    const hashes = [...unresolved];
    for (let start = 0; start < hashes.length; start += batchSize) {
      const batch = hashes.slice(start, start + batchSize);
      const query = db
        .selectFrom("memory_embedding_cache")
        .select(["hash", "embedding"])
        // Legacy dimensions can exceed JavaScript's safe integer range.
        .select((eb) =>
          eb
            .or([
              eb("dims", "is", null),
              eb("dims", "=", eb(eb.fn<number>("length", ["embedding"]), "/", eb.lit(8))),
            ])
            .as("dimensions_match"),
        )
        .where("provider", "=", identity.provider)
        .where("model", "=", identity.model)
        .where("provider_key", "=", identity.providerKey)
        .where("hash", "in", batch);
      for (const row of iterateSqliteQuerySync(params.db, query)) {
        // The first stored row wins even when its vector needs to be regenerated.
        const embedding = decodeMemoryEmbedding(row.embedding);
        out.set(
          row.hash,
          row.dimensions_match && isValidMemoryEmbedding(embedding) ? embedding : [],
        );
        unresolved.delete(row.hash);
      }
    }
  }
  return out;
}

export function countMemoryEmbeddingCache(database: DatabaseSync): number {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  const result = executeSqliteQuerySync(
    database,
    db.selectFrom("memory_embedding_cache").select((eb) => eb.fn.countAll<number>().as("count")),
  );
  return result.rows[0]!.count;
}

/** The caller holds the write transaction; another purge may have reduced the cache. */
export function pruneMemoryEmbeddingCache(
  database: DatabaseSync,
  maxEntries: number,
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference,
): void {
  const excess = countMemoryEmbeddingCache(database) - maxEntries;
  if (excess <= 0) {
    return;
  }
  evictMemoryEmbeddingCacheRows(database, Math.min(excess, 100), unreferencedFirst);
}

/** Remove exactly `limit` rows (fewer only if the cache is smaller): preferred rows first, then the oldest. */
function evictMemoryEmbeddingCacheRows(
  database: DatabaseSync,
  limit: number,
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference,
): void {
  const evicted = unreferencedFirst
    ? deleteOldestUnreferencedMemoryEmbeddingCacheRows(database, unreferencedFirst, limit)
    : 0;
  if (evicted < limit) {
    deleteOldestMemoryEmbeddingCacheRows(database, limit - evicted);
  }
}

function deleteOldestMemoryEmbeddingCacheRows(database: DatabaseSync, limit: number): void {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  // SQLite performs eviction without materializing the full cache in JavaScript.
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("memory_embedding_cache")
      .where(
        "rowid",
        "in",
        db
          .selectFrom("memory_embedding_cache")
          .select("rowid")
          .orderBy("updated_at", "asc")
          .orderBy("rowid", "asc")
          .limit(limit),
      ),
  );
}

function deleteOldestUnreferencedMemoryEmbeddingCacheRows(
  database: DatabaseSync,
  preference: MemoryEmbeddingCacheEvictionPreference,
  limit: number,
): number {
  if (preference.identities.length === 0) {
    return 0;
  }
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  // Both uncorrelated subqueries are evaluated once per statement, so the
  // unindexed chunk columns are scanned once rather than once per cache row.
  // An empty index has no oldest chunk, so nothing is preferred.
  const result = executeSqliteQuerySync(
    database,
    db.deleteFrom("memory_embedding_cache").where(
      "rowid",
      "in",
      db
        .selectFrom("memory_embedding_cache")
        .select("rowid")
        // Casting the TEXT key columns is a no-op that keeps SQLite from answering the
        // identity filter through the primary key and then sorting every row by
        // updated_at, which sits after the vector; the updated_at index walk stops
        // at the limit instead.
        .where((eb) =>
          eb.or(
            preference.identities.map((identity) =>
              eb.and([
                eb(eb.cast("provider", "text"), "=", identity.provider),
                eb(eb.cast("model", "text"), "=", identity.model),
                eb(eb.cast("provider_key", "text"), "=", identity.providerKey),
              ]),
            ),
          ),
        )
        .where((eb) =>
          eb(
            "updated_at",
            "<",
            eb
              .selectFrom("memory_index_chunks")
              .select((chunks) => chunks.fn.min<number>("updated_at").as("oldest")),
          ),
        )
        .where("hash", "not in", db.selectFrom("memory_index_chunks").select("hash"))
        .orderBy("updated_at", "asc")
        .orderBy("rowid", "asc")
        .limit(limit),
    ),
  );
  return Number(result.numAffectedRows ?? 0);
}

/** Discard ambiguous vector spaces without removing unrelated provider caches or index rows. */
export function clearMemoryEmbeddingCacheIdentities(
  database: DatabaseSync,
  identities: MemoryIndexProviderIdentity[],
): void {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  for (const identity of identities) {
    executeSqliteQuerySync(
      database,
      db
        .deleteFrom("memory_embedding_cache")
        .where("provider", "=", identity.provider)
        .where("model", "=", identity.model)
        .where("provider_key", "=", identity.providerKey),
    );
  }
}

export function upsertMemoryEmbeddingCache(params: {
  db: DatabaseSync;
  provider: { id: string; model: string };
  providerKey: string;
  /** Stable replayable rows let staged writes retain hashes without a second vector batch. */
  entries: () => Iterable<{ hash: string; embedding: number[] }>;
  maxEntries?: number;
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference;
  now?: number;
}): void {
  const provider = params.provider;
  const lastRows = new Map<string, number>();
  let row = 0;
  for (const entry of params.entries()) {
    lastRows.set(entry.hash, row++);
  }
  const uniqueRows = [...lastRows].toSorted((left, right) => left[1] - right[1]);
  const maxEntries =
    typeof params.maxEntries === "number" &&
    Number.isFinite(params.maxEntries) &&
    params.maxEntries > 0
      ? Math.floor(params.maxEntries)
      : undefined;
  const retainedRows = maxEntries === undefined ? uniqueRows : uniqueRows.slice(-maxEntries);
  if (retainedRows.length === 0) {
    return;
  }
  if (maxEntries !== undefined) {
    const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db);
    const hashes = retainedRows.map(([hash]) => hash);
    // Reserve space before inserting vectors so even a transient overflow is impossible.
    for (let start = 0; start < hashes.length; start += 400) {
      executeSqliteQuerySync(
        params.db,
        db
          .deleteFrom("memory_embedding_cache")
          .where("provider", "=", provider.id)
          .where("model", "=", provider.model)
          .where("provider_key", "=", params.providerKey)
          .where("hash", "in", hashes.slice(start, start + 400)),
      );
    }
    const excess = countMemoryEmbeddingCache(params.db) - (maxEntries - hashes.length);
    if (excess > 0) {
      evictMemoryEmbeddingCacheRows(params.db, excess, params.unreferencedFirst);
    }
  }
  const now = params.now ?? Date.now();
  const { compiled, bind } = compileSqliteQueryBindings<{ hash: string; embedding: number[] }>(
    (parameter) =>
      getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db)
        .insertInto("memory_embedding_cache")
        .values({
          provider: provider.id,
          model: provider.model,
          provider_key: params.providerKey,
          hash: parameter((entry) => entry.hash),
          embedding: parameter((entry) => encodeMemoryEmbedding(entry.embedding)),
          dims: parameter((entry) => entry.embedding.length),
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["provider", "model", "provider_key", "hash"]).doUpdateSet((eb) => ({
            embedding: eb.ref("excluded.embedding"),
            dims: eb.ref("excluded.dims"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
  );
  const statement = params.db.prepare(compiled.sql);
  statement.setReadBigInts(true);
  const retained = new Set(retainedRows.map(([, index]) => index));
  row = 0;
  for (const entry of params.entries()) {
    if (!retained.has(row++)) {
      continue;
    }
    statement.run(...bind(entry));
  }
}

export function collectMemoryCachedEmbeddings(params: {
  hashes: string[];
  cached: Map<string, number[]>;
}): { embeddings: number[][]; missing: number[] } {
  const missing: number[] = [];
  const embeddings = params.hashes.map((hash, index) => {
    const hit = hash ? params.cached.get(hash) : undefined;
    if (hit && hit.length > 0) {
      return hit;
    }
    missing.push(index);
    return [];
  });
  return { embeddings, missing };
}
