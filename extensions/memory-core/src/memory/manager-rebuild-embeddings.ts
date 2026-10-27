import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { resolveEmbeddingInputFormatVersion } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  decodeMemoryEmbedding,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isValidMemoryEmbedding } from "./manager-embedding-cache.js";
import type { MemoryIndexProviderIdentity } from "./manager-reindex-state.js";
import { MEMORY_INDEX_META_KEY } from "./manager-retrieval-read.js";

const rebuildIdentitySchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  providerKey: Type.String(),
  embeddingInputFormatVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  vectorDims: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});

export type MemoryRebuildEmbeddingQuery = {
  chunks: Array<{ source: MemorySource; path: string; hash: string }>;
  dimensions?: number;
};

/** Read only this rebuild batch, using the published source/path index on either engine. */
export function loadMemoryRebuildEmbeddings(params: {
  db: EngineConnection;
  identity: MemoryIndexProviderIdentity;
  query: MemoryRebuildEmbeddingQuery;
  cached: Map<string, number[]>;
}): void {
  const sources = new Map<string, { source: MemorySource; path: string; hashes: Set<string> }>();
  for (const chunk of params.query.chunks) {
    if (params.cached.has(chunk.hash)) {
      continue;
    }
    const key = `${chunk.source}:${chunk.path}`;
    let source = sources.get(key);
    if (!source) {
      source = { source: chunk.source, path: chunk.path, hashes: new Set() };
      sources.set(key, source);
    }
    source.hashes.add(chunk.hash);
  }
  if (sources.size === 0) {
    return;
  }
  const db = getNodeSqliteKysely<{
    memory_index_meta: { key: string; value: string };
    memory_index_chunks: {
      source: MemorySource;
      path: string;
      hash: string;
      model: string;
      embedding: Uint8Array;
    };
  }>(params.db);
  const row = executeSqliteQueryTakeFirstSync(
    params.db,
    db.selectFrom("memory_index_meta").select("value").where("key", "=", MEMORY_INDEX_META_KEY),
  );
  if (!row) {
    return;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(row.value);
  } catch {
    return;
  }
  const { identity, query } = params;
  if (
    !Value.Check(rebuildIdentitySchema, meta) ||
    meta.model === "fts-only" ||
    meta.provider !== identity.provider ||
    meta.model !== identity.model ||
    meta.providerKey !== identity.providerKey ||
    (meta.embeddingInputFormatVersion ?? 0) !==
      resolveEmbeddingInputFormatVersion(identity.model) ||
    (query.dimensions !== undefined && query.dimensions !== meta.vectorDims)
  ) {
    return;
  }
  for (const source of sources.values()) {
    const hashes = [...source.hashes].filter((hash) => !params.cached.has(hash));
    for (let start = 0; start < hashes.length; start += 400) {
      const rows = db
        .selectFrom("memory_index_chunks")
        .select(["hash", "embedding"])
        .where("source", "=", source.source)
        .where("path", "=", source.path)
        .where("model", "=", meta.model)
        .where("hash", "in", hashes.slice(start, start + 400))
        // Bind identity and vectors to the same snapshot if another rebuild publishes.
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("memory_index_meta")
              .select("key")
              .where("key", "=", MEMORY_INDEX_META_KEY)
              .where("value", "=", row.value),
          ),
        );
      for (const chunk of iterateSqliteQuerySync(params.db, rows)) {
        const embedding = decodeMemoryEmbedding(chunk.embedding);
        if (!params.cached.has(chunk.hash) && isValidMemoryEmbedding(embedding, meta.vectorDims)) {
          params.cached.set(chunk.hash, embedding);
        }
      }
    }
  }
}
