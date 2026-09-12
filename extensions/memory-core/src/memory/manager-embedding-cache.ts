// Memory Core plugin module implements manager embedding cache behavior.
import type { DatabaseSync } from "node:sqlite";
import {
  parseEmbedding,
  type MemoryChunk,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  type Generated,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryIndexProviderIdentity } from "./manager-reindex-state.js";

type MemoryEmbeddingCacheRow = {
  provider: string;
  model: string;
  provider_key: string;
  hash: string;
  embedding: string;
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
  enabled: boolean;
  providerIdentities: MemoryIndexProviderIdentity[];
  hashes: string[];
}): Map<string, number[]> {
  if (!params.enabled || params.providerIdentities.length === 0 || params.hashes.length === 0) {
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
        .where("provider", "=", identity.provider)
        .where("model", "=", identity.model)
        .where("provider_key", "=", identity.providerKey)
        .where("hash", "in", batch);
      for (const row of iterateSqliteQuerySync(params.db, query)) {
        // The first stored row wins even when its vector needs to be regenerated.
        const embedding = parseEmbedding(row.embedding);
        out.set(row.hash, isValidMemoryEmbedding(embedding) ? embedding : []);
        unresolved.delete(row.hash);
      }
    }
  }
  return out;
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
  return (row: MemoryEmbeddingCacheRow) => statement.run(...bind(row));
}

export function upsertMemoryEmbeddingCache(params: {
  db: DatabaseSync;
  enabled: boolean;
  provider: { id: string; model: string } | null;
  providerKey: string | null;
  entries: Array<{ hash: string; embedding: number[] }>;
  maxEntries?: number;
  now?: number;
}): void {
  const provider = params.provider;
  if (!params.enabled || !provider || !params.providerKey || params.entries.length === 0) {
    return;
  }
  const seenHashes = new Set<string>();
  const uniqueEntries: Array<{ hash: string; embedding: number[] }> = [];
  for (let index = params.entries.length - 1; index >= 0; index -= 1) {
    const entry = params.entries[index];
    if (entry && !seenHashes.has(entry.hash)) {
      seenHashes.add(entry.hash);
      uniqueEntries.push(entry);
    }
  }
  uniqueEntries.reverse();
  const maxEntries =
    typeof params.maxEntries === "number" &&
    Number.isFinite(params.maxEntries) &&
    params.maxEntries > 0
      ? Math.floor(params.maxEntries)
      : undefined;
  const retainedEntries =
    maxEntries === undefined ? uniqueEntries : uniqueEntries.slice(-maxEntries);
  if (retainedEntries.length === 0) {
    return;
  }
  if (maxEntries !== undefined) {
    reserveMemoryEmbeddingCacheCapacity({
      db: params.db,
      provider,
      providerKey: params.providerKey,
      hashes: retainedEntries.map((entry) => entry.hash),
      maxEntries,
    });
  }
  const now = params.now ?? Date.now();
  const upsert = prepareMemoryEmbeddingCacheUpsert(params.db);
  for (const entry of retainedEntries) {
    const embedding = entry.embedding ?? [];
    upsert({
      provider: provider.id,
      model: provider.model,
      provider_key: params.providerKey,
      hash: entry.hash,
      embedding: JSON.stringify(embedding),
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
  // SQLite performs eviction without materializing the full cache in JavaScript.
  executeSqliteQuerySync(
    params.db,
    db.deleteFrom("memory_embedding_cache").where(
      "rowid",
      "in",
      db
        .selectFrom("memory_embedding_cache")
        .select("rowid")
        .orderBy("updated_at", "desc")
        .orderBy("rowid", "desc")
        .limit(-1)
        .offset(params.maxEntries - params.hashes.length),
    ),
  );
}

export function collectMemoryCachedEmbeddings<T extends Pick<MemoryChunk, "hash">>(params: {
  chunks: T[];
  cached: Map<string, number[]>;
}): {
  embeddings: number[][];
  missing: Array<{ index: number; chunk: T }>;
} {
  const embeddings: number[][] = Array.from({ length: params.chunks.length }, () => []);
  const missing: Array<{ index: number; chunk: T }> = [];

  for (let index = 0; index < params.chunks.length; index += 1) {
    const chunk = params.chunks[index];
    const hit = chunk?.hash ? params.cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[index] = hit;
    } else if (chunk) {
      missing.push({ index, chunk });
    }
  }

  return { embeddings, missing };
}
