import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { rekeyMemoryEmbeddingCache } from "./manager-embedding-cache.js";
import {
  EMBEDDING_REFUSAL_META_KEY,
  parseMemoryEmbeddingRefusal,
  type MemoryEmbeddingRefusal,
} from "./manager-embedding-refusal.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { MEMORY_INDEX_META_KEY } from "./manager-retrieval-read.js";

type MetadataDatabase = { memory_index_meta: { key: string; value: string } };

export function writeMemoryIndexMetadata(database: EngineConnection, meta: MemoryIndexMeta): void {
  const value = JSON.stringify(meta);
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<MetadataDatabase>(database)
      .insertInto("memory_index_meta")
      .values({ key: MEMORY_INDEX_META_KEY, value })
      .onConflict((conflict) => conflict.column("key").doUpdateSet({ value })),
  );
}

export function readMemoryEmbeddingRefusal(database: EngineConnection) {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<MetadataDatabase>(database)
      .selectFrom("memory_index_meta")
      .select("value")
      .where("key", "=", EMBEDDING_REFUSAL_META_KEY),
  );
  return parseMemoryEmbeddingRefusal(row?.value);
}

/** The refusal describes the endpoint, not index content; null forgets it. */
export function writeMemoryEmbeddingRefusal(
  database: EngineConnection,
  refusal: MemoryEmbeddingRefusal | null,
): void {
  const query = getNodeSqliteKysely<MetadataDatabase>(database);
  if (!refusal) {
    executeSqliteQuerySync(
      database,
      query.deleteFrom("memory_index_meta").where("key", "=", EMBEDDING_REFUSAL_META_KEY),
    );
    return;
  }
  const value = JSON.stringify(refusal);
  executeSqliteQuerySync(
    database,
    query
      .insertInto("memory_index_meta")
      .values({ key: EMBEDDING_REFUSAL_META_KEY, value })
      .onConflict((conflict) => conflict.column("key").doUpdateSet({ value })),
  );
}

/** The publication owner holds one transaction for metadata and its cache namespace. */
export function upgradeMemoryIndexProviderKey(
  database: EngineConnection,
  { meta, providerKey }: { meta: MemoryIndexMeta; providerKey: string },
): boolean {
  if (!meta.providerKey || meta.providerKey === providerKey) {
    return false;
  }
  const updated = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<MetadataDatabase>(database)
      .updateTable("memory_index_meta")
      .set({ value: JSON.stringify({ ...meta, providerKey }) })
      .where("key", "=", MEMORY_INDEX_META_KEY)
      .where("value", "=", JSON.stringify(meta)),
  );
  if (!Number(updated.numAffectedRows)) {
    return false;
  }
  if (tableExists(database, "memory_embedding_cache")) {
    rekeyMemoryEmbeddingCache(
      database,
      {
        provider: meta.provider,
        model: meta.model,
        providerKey: meta.providerKey,
      },
      providerKey,
    );
  }
  return true;
}
