// Memory Core plugin module implements manager embedding cache behavior.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  parseEmbedding,
  type MemoryChunk,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { vectorToBlob } from "./manager-vector-write.js";

type EmbeddingCacheDb = Pick<DatabaseSync, "prepare">;

// Backward-compat invariant for `memory_embedding_cache.embedding`:
//
// New rows are written as a packed Float32 BLOB (via `vectorToBlob`) instead of
// JSON TEXT. This is ~9x cheaper to write and ~5x smaller on disk than
// `JSON.stringify` of a 1536-dim vector (JSON serialization was ~95% of the
// upsert CPU). The vec0 vector path already stores embeddings this way, so the
// round-trip is well-proven in this codebase.
//
// The cache column has TEXT affinity, but SQLite affinity is a storage
// *preference*, not a constraint: a BLOB value is stored (and round-tripped) as
// a BLOB even in a TEXT-affinity column, and `NOT NULL` is still satisfied. The
// `node:sqlite` driver returns such a value as a `Uint8Array`, so reads detect
// the value type:
//   - `Uint8Array` (covers Node `Buffer`, which extends it) -> packed Float32 BLOB
//   - `string` -> legacy JSON TEXT row, decoded with `parseEmbedding`
// Legacy TEXT rows therefore keep working with NO re-embed and NO migration, and
// because this table is a rebuildable provider-response cache (not the durable
// index), even a fully cold cache is safe — entries are re-fetched on demand.
function decodeCachedEmbedding(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    // Zero-copy view over the stored bytes; Array.from materializes the floats.
    const floats = new Float32Array(
      value.buffer,
      value.byteOffset,
      Math.floor(value.byteLength / 4),
    );
    return Array.from(floats);
  }
  if (typeof value === "string") {
    return parseEmbedding(value);
  }
  return [];
}

type EmbeddingProviderIdentity = {
  provider: string;
  model: string;
  providerKey: string;
};

export function loadMemoryEmbeddingCache(params: {
  db: EmbeddingCacheDb;
  enabled: boolean;
  providerIdentities: EmbeddingProviderIdentity[];
  hashes: string[];
  tableName?: string;
}): Map<string, number[]> {
  if (!params.enabled || params.providerIdentities.length === 0 || params.hashes.length === 0) {
    return new Map();
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hash of params.hashes) {
    if (!hash || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    unique.push(hash);
  }
  if (unique.length === 0) {
    return new Map();
  }

  const tableName = params.tableName ?? "memory_embedding_cache";
  const out = new Map<string, number[]>();
  const batchSize = 400;
  for (const identity of params.providerIdentities) {
    const baseParams: SQLInputValue[] = [identity.provider, identity.model, identity.providerKey];
    for (let start = 0; start < unique.length; start += batchSize) {
      const batch = unique.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = params.db
        .prepare(
          `SELECT hash, embedding FROM ${tableName}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{
        hash: string;
        embedding: string | Uint8Array;
      }>;
      for (const row of rows) {
        if (!out.has(row.hash)) {
          out.set(row.hash, decodeCachedEmbedding(row.embedding));
        }
      }
    }
  }
  return out;
}

export function upsertMemoryEmbeddingCache(params: {
  db: EmbeddingCacheDb;
  enabled: boolean;
  provider: { id: string; model: string } | null;
  providerKey: string | null;
  entries: Array<{ hash: string; embedding: number[] }>;
  now?: number;
  tableName?: string;
}): void {
  const provider = params.provider;
  if (!params.enabled || !provider || !params.providerKey || params.entries.length === 0) {
    return;
  }
  const tableName = params.tableName ?? "memory_embedding_cache";
  const now = params.now ?? Date.now();
  const stmt = params.db.prepare(
    `INSERT INTO ${tableName} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
      ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
      `   embedding=excluded.embedding,\n` +
      `   dims=excluded.dims,\n` +
      `   updated_at=excluded.updated_at`,
  );
  for (const entry of params.entries) {
    const embedding = entry.embedding ?? [];
    stmt.run(
      provider.id,
      provider.model,
      params.providerKey,
      entry.hash,
      // Packed Float32 BLOB (see decodeCachedEmbedding for the read-side
      // backward-compat contract). Replaces JSON.stringify, which dominated
      // upsert CPU for high-dimensional vectors.
      vectorToBlob(embedding),
      embedding.length,
      now,
    );
  }
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
