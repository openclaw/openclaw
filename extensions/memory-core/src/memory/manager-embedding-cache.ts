import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  decodeMemoryEmbedding,
  encodeMemoryEmbedding,
  isPostgresSqlConnection,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  type Generated,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { MemoryIndexProviderIdentity } from "./manager-reindex-state.js";

export type MemoryEmbeddingCacheSize = { size: number; exact: boolean };

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
  db: EngineConnection;
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

/** Preserve canonical entries and move the remaining legacy rows without copying vectors. */
export function rekeyMemoryEmbeddingCache(
  database: EngineConnection,
  identity: MemoryIndexProviderIdentity,
  providerKey: string,
): void {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("memory_embedding_cache")
      .where("provider", "=", identity.provider)
      .where("model", "=", identity.model)
      .where("provider_key", "=", identity.providerKey)
      .where(
        "hash",
        "in",
        db
          .selectFrom("memory_embedding_cache")
          .select("hash")
          .where("provider", "=", identity.provider)
          .where("model", "=", identity.model)
          .where("provider_key", "=", providerKey),
      ),
  );
  executeSqliteQuerySync(
    database,
    db
      .updateTable("memory_embedding_cache")
      .set({ provider_key: providerKey })
      .where("provider", "=", identity.provider)
      .where("model", "=", identity.model)
      .where("provider_key", "=", identity.providerKey),
  );
}

export function countMemoryEmbeddingCache(database: EngineConnection): number {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  const result = executeSqliteQuerySync(
    database,
    db.selectFrom("memory_embedding_cache").select((eb) => eb.fn.countAll<number>().as("count")),
  );
  return result.rows[0]!.count;
}

/** The publication owner supplies its retained count and holds the write transaction. */
export function pruneMemoryEmbeddingCache(
  database: EngineConnection,
  cacheSize: MemoryEmbeddingCacheSize,
  maxEntries: number,
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference,
): MemoryEmbeddingCacheSize {
  if (cacheSize.size <= maxEntries) {
    return cacheSize;
  }
  const size = cacheSize.exact ? cacheSize.size : countMemoryEmbeddingCache(database);
  const excess = size - maxEntries;
  if (excess <= 0) {
    return { size, exact: true };
  }
  const limit = Math.min(excess, 100);
  const removed = deleteOldestMemoryEmbeddingCacheRows(database, limit, unreferencedFirst);
  return { size: size - removed, exact: true };
}

function deleteOldestMemoryEmbeddingCacheRows(
  database: EngineConnection,
  limit: number,
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference,
): number {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  const postgres = isPostgresSqlConnection(database);
  const deleteOldest = (count: number, identities: MemoryIndexProviderIdentity[] = []) => {
    let rows = db.selectFrom("memory_embedding_cache");
    if (identities.length > 0) {
      // Both uncorrelated chunk subqueries run once per statement; an empty index prefers nothing.
      rows = rows
        .where((eb) => {
          // SQLite only: the no-op TEXT cast keeps the planner off the primary key, so it walks
          // the updated_at index and stops at the limit instead of sorting every match.
          const key = (column: "provider" | "model" | "provider_key") =>
            postgres ? eb.ref(column) : eb.cast(column, "text");
          return eb.or(
            identities.map((identity) =>
              eb.and([
                eb(key("provider"), "=", identity.provider),
                eb(key("model"), "=", identity.model),
                eb(key("provider_key"), "=", identity.providerKey),
              ]),
            ),
          );
        })
        .where((eb) =>
          eb(
            "updated_at",
            "<",
            eb
              .selectFrom("memory_index_chunks")
              .select((chunks) => chunks.fn.min("updated_at").as("oldest")),
          ),
        )
        .where("hash", "not in", db.selectFrom("memory_index_chunks").select("hash"));
    }
    if (postgres) {
      const keys = ["provider", "model", "provider_key", "hash"] as const;
      const oldest = rows
        .select(keys)
        // Generated PostgreSQL index keys are ASC NULLS FIRST; matching lets this stop at the limit.
        .orderBy("updated_at", (order) => order.asc().nullsFirst())
        .orderBy("provider", "asc")
        .orderBy("model", "asc")
        .orderBy("provider_key", "asc")
        .orderBy("hash", "asc")
        .limit(count)
        .$asTuple(...keys);
      const result = executeSqliteQuerySync(
        database,
        db
          .deleteFrom("memory_embedding_cache")
          .where((eb) => eb(eb.refTuple(...keys), "in", oldest)),
      );
      return Number(result.numAffectedRows);
    }
    // SQLite performs eviction without materializing the full cache in JavaScript.
    const result = executeSqliteQuerySync(
      database,
      db
        .deleteFrom("memory_embedding_cache")
        .where(
          "rowid",
          "in",
          rows.select("rowid").orderBy("updated_at", "asc").orderBy("rowid", "asc").limit(count),
        ),
    );
    return Number(result.numAffectedRows);
  };
  // Preferred rows fill the unchanged count first; the remainder stays oldest-first.
  const preferred = unreferencedFirst ? deleteOldest(limit, unreferencedFirst.identities) : 0;
  return preferred < limit ? preferred + deleteOldest(limit - preferred) : preferred;
}

/** Discard ambiguous vector spaces without removing unrelated provider caches or index rows. */
export function clearMemoryEmbeddingCacheIdentities(
  database: EngineConnection,
  identities: MemoryIndexProviderIdentity[],
): number {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(database);
  let removed = 0;
  for (const identity of identities) {
    const result = executeSqliteQuerySync(
      database,
      db
        .deleteFrom("memory_embedding_cache")
        .where("provider", "=", identity.provider)
        .where("model", "=", identity.model)
        .where("provider_key", "=", identity.providerKey),
    );
    removed += Number(result.numAffectedRows);
  }
  return removed;
}

export function upsertMemoryEmbeddingCache(params: {
  db: EngineConnection;
  cacheSize: MemoryEmbeddingCacheSize;
  provider: { id: string; model: string };
  providerKey: string;
  /** Stable replayable rows let staged writes retain hashes without a second vector batch. */
  entries: () => Iterable<{ hash: string; embedding: number[] }>;
  maxEntries?: number;
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference;
  now?: number;
}): MemoryEmbeddingCacheSize {
  let cacheSize = params.cacheSize;
  let exactAfterInsert = cacheSize.exact && cacheSize.size === 0;
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
    return cacheSize;
  }
  if (maxEntries !== undefined && cacheSize.size + retainedRows.length > maxEntries) {
    const reserved = reserveMemoryEmbeddingCacheCapacity({
      db: params.db,
      cacheSize,
      provider,
      providerKey: params.providerKey,
      hashes: retainedRows.map(([hash]) => hash),
      maxEntries,
      unreferencedFirst: params.unreferencedFirst,
    });
    cacheSize = { size: reserved.size, exact: true };
    exactAfterInsert = reserved.exactAfterInsert;
  }
  const now = params.now ?? Date.now();
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db);
  let batch: MemoryEmbeddingCacheRow[] = [];
  const flush = () => {
    if (batch.length === 0) {
      return;
    }
    executeSqliteQuerySync(
      params.db,
      db
        .insertInto("memory_embedding_cache")
        .values(batch)
        .onConflict((conflict) =>
          conflict.columns(["provider", "model", "provider_key", "hash"]).doUpdateSet((eb) => ({
            embedding: eb.ref("excluded.embedding"),
            dims: eb.ref("excluded.dims"),
            updated_at: eb.ref("excluded.updated_at"),
          })),
        ),
    );
    batch = [];
  };
  const retained = new Set(retainedRows.map(([, index]) => index));
  row = 0;
  for (const entry of params.entries()) {
    if (!retained.has(row++)) {
      continue;
    }
    batch.push({
      provider: provider.id,
      model: provider.model,
      provider_key: params.providerKey,
      hash: entry.hash,
      embedding: encodeMemoryEmbedding(entry.embedding),
      dims: entry.embedding.length,
      updated_at: now,
    });
    // Bound encoded vectors and stay below SQLite's portable binding limit.
    if (batch.length === 128) {
      flush();
    }
  }
  flush();
  // Reservation removes replacement keys, so every retained row then increments the count.
  return { size: cacheSize.size + retainedRows.length, exact: exactAfterInsert };
}

/*
 * Evicts before inserting so even an uncommitted write never holds more rows than the cap;
 * a forced rebuild otherwise grows the primary file before the excess is deleted. The
 * retained count needs a reread only when inexact. Below capacity a direct UPSERT cannot
 * overflow; at capacity, removing replaced rows makes every UPSERT row a true insert.
 */
function reserveMemoryEmbeddingCacheCapacity(params: {
  db: EngineConnection;
  cacheSize: MemoryEmbeddingCacheSize;
  provider: { id: string; model: string };
  providerKey: string;
  hashes: string[];
  maxEntries: number;
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference;
}): { size: number; exactAfterInsert: boolean } {
  const { hashes, maxEntries, cacheSize } = params;
  let size = cacheSize.exact ? cacheSize.size : countMemoryEmbeddingCache(params.db);
  if (size + hashes.length <= maxEntries) {
    return { size, exactAfterInsert: size === 0 };
  }
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db);
  // Chunks stay below SQLite's portable binding limit.
  for (let start = 0; start < hashes.length; start += 400) {
    const result = executeSqliteQuerySync(
      params.db,
      db
        .deleteFrom("memory_embedding_cache")
        .where("provider", "=", params.provider.id)
        .where("model", "=", params.provider.model)
        .where("provider_key", "=", params.providerKey)
        .where("hash", "in", hashes.slice(start, start + 400)),
    );
    size -= Number(result.numAffectedRows);
  }
  const excess = size + hashes.length - maxEntries;
  if (excess > 0) {
    size -= deleteOldestMemoryEmbeddingCacheRows(params.db, excess, params.unreferencedFirst);
  }
  return { size, exactAfterInsert: true };
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
