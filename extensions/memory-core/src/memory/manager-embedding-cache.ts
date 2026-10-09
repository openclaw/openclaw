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
export function pruneMemoryEmbeddingCache(database: DatabaseSync, maxEntries: number): void {
  const excess = countMemoryEmbeddingCache(database) - maxEntries;
  if (excess <= 0) {
    return;
  }
  deleteOldestMemoryEmbeddingCacheRows(database, Math.min(excess, 100));
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

function prepareMemoryEmbeddingCacheUpsert(db: DatabaseSync) {
  const { compiled, bind } = compileSqliteQueryBindings<MemoryEmbeddingCacheRow>((parameter) =>
    getNodeSqliteKysely<EmbeddingCacheDatabase>(db)
      .insertInto("memory_embedding_cache")
      .values({
        provider: parameter((row) => row.provider),
        model: parameter((row) => row.model),
        provider_key: parameter((row) => row.provider_key),
        hash: parameter((row) => row.hash),
        embedding: parameter((row) => row.embedding),
        dims: parameter((row) => row.dims),
        updated_at: parameter((row) => row.updated_at),
      })
      .onConflict((conflict) =>
        conflict.columns(["provider", "model", "provider_key", "hash"]).doUpdateSet((eb) => ({
          embedding: eb.ref("excluded.embedding"),
          dims: eb.ref("excluded.dims"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      ),
  );
  // The caller owns this statement for its write loop, including large embedding bindings.
  const statement = db.prepare(compiled.sql);
  statement.setReadBigInts(true);
  return (row: MemoryEmbeddingCacheRow) => statement.run(...bind(row));
}

export function upsertMemoryEmbeddingCache(params: {
  db: DatabaseSync;
  provider: { id: string; model: string };
  providerKey: string;
  /** Stable replayable rows let staged writes retain hashes without a second vector batch. */
  entries: () => Iterable<{ hash: string; embedding: number[] }>;
  maxEntries?: number;
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
    reserveMemoryEmbeddingCacheCapacity({
      db: params.db,
      provider,
      providerKey: params.providerKey,
      hashes: retainedRows.map(([hash]) => hash),
      maxEntries,
    });
  }
  const now = params.now ?? Date.now();
  const upsert = prepareMemoryEmbeddingCacheUpsert(params.db);
  const retained = new Set(retainedRows.map(([, index]) => index));
  row = 0;
  for (const entry of params.entries()) {
    if (!retained.has(row++)) {
      continue;
    }
    const embedding = entry.embedding;
    upsert({
      provider: provider.id,
      model: provider.model,
      provider_key: params.providerKey,
      hash: entry.hash,
      embedding: encodeMemoryEmbedding(embedding),
      dims: embedding.length,
      updated_at: now,
    });
  }
}

function reserveMemoryEmbeddingCacheCapacity(params: {
  db: DatabaseSync;
  provider: { id: string; model: string };
  providerKey: string;
  hashes: string[];
  maxEntries: number;
}): void {
  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db);
  // The caller's transaction replaces incoming rows and reserves space before
  // inserting vectors, so even a transient row-count overflow is impossible.
  for (let start = 0; start < params.hashes.length; start += 400) {
    executeSqliteQuerySync(
      params.db,
      db
        .deleteFrom("memory_embedding_cache")
        .where("provider", "=", params.provider.id)
        .where("model", "=", params.provider.model)
        .where("provider_key", "=", params.providerKey)
        .where("hash", "in", params.hashes.slice(start, start + 400)),
    );
  }
  const retainedCapacity = params.maxEntries - params.hashes.length;
  const excess = countMemoryEmbeddingCache(params.db) - retainedCapacity;
  if (excess > 0) {
    deleteOldestMemoryEmbeddingCacheRows(params.db, excess);
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
