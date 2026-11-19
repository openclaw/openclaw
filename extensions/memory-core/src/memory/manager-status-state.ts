import fs from "node:fs";
import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import {
  isPostgresSqlConnection,
  type MemoryProviderStatus,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { buildMemorySourceFilter } from "./source-filter.js";

export type MemoryStatusQuery = {
  sources: MemorySource[];
  cacheEnabled: boolean;
  includeStorage: boolean;
};

export function collectMemoryStatusSnapshot(
  db: EngineConnection | undefined,
  databasePath: string,
  query: MemoryStatusQuery,
) {
  const filter = buildMemorySourceFilter(undefined, query.sources);
  const aggregate = collectMemoryStatusAggregate({
    db,
    sources: query.sources,
    sourceFilterSql: filter.sql,
    sourceFilterParams: filter.params,
    includeChunkBytes: query.includeStorage,
  });
  const storage = query.includeStorage ? collectMemoryStorageStatus(db, databasePath) : undefined;
  const cacheEntries =
    storage?.embeddingCacheEntries ??
    (db && query.cacheEnabled
      ? Number(db.prepare("SELECT COUNT(*) as c FROM memory_embedding_cache").get()?.c ?? 0)
      : 0);
  return { aggregate, storage, cacheEntries };
}

type StatusProvider = {
  id: string;
  model: string;
};

type StatusAggregateRow = {
  kind: "files" | "chunks";
  source: MemorySource;
  c: number;
  bytes: number | null;
};

/** Read only for explicit diagnostics: retained cache payloads can be large even when disabled. */
function collectMemoryStorageStatus(
  db: EngineConnection | undefined,
  databasePath: string,
): NonNullable<MemoryProviderStatus["storage"]> {
  const query = db
    ? getNodeSqliteKysely<{ memory_embedding_cache: { embedding: Uint8Array } }>(db)
        .selectFrom("memory_embedding_cache")
        .select((eb) => [
          eb.fn.countAll<number>().as("entries"),
          eb.fn
            .coalesce(eb.fn.sum<number>(eb.fn<number>("octet_length", ["embedding"])), eb.val(0))
            .as("bytes"),
        ])
    : undefined;
  const cache = db && query ? executeSqliteQuerySync(db, query).rows[0]! : { bytes: 0, entries: 0 };
  if (db && isPostgresSqlConnection(db)) {
    // Table presence comes from admission; relation sizes are explicit diagnostics, not schema probes.
    const tables = [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunk_provenance",
      "memory_index_chunk_recall_metadata",
      "memory_index_meta",
      "memory_index_state",
      "memory_embedding_cache",
      "memory_index_chunks_vec",
    ].filter((table) => tableExists(db, table));
    const bytes = db
      .prepare(
        "SELECT COALESCE(SUM(pg_total_relation_size(value::regclass)), 0) AS bytes FROM json_array_elements_text(?::json)",
      )
      .get(JSON.stringify(tables))?.bytes;
    return {
      databaseBytes: Number(bytes ?? 0),
      walBytes: 0,
      reusableBytes: 0,
      embeddingCacheBytes: cache.bytes,
      embeddingCacheEntries: cache.entries,
    };
  }
  const pageSize = db ? Number(db.prepare("PRAGMA page_size").get()?.page_size) : 0;
  const freePages = db ? Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count) : 0;
  return {
    databaseBytes: fs.statSync(databasePath, { throwIfNoEntry: false })?.size ?? 0,
    walBytes: fs.statSync(`${databasePath}-wal`, { throwIfNoEntry: false })?.size ?? 0,
    reusableBytes: freePages * pageSize,
    embeddingCacheBytes: cache.bytes,
    embeddingCacheEntries: cache.entries,
  };
}

export function resolveStatusProviderInfo(params: {
  provider: StatusProvider | null;
  providerInitialized: boolean;
  requestedProvider: string;
  resolveConfiguredModel?: () => string | undefined;
}): {
  provider: string;
  model?: string;
  searchMode: "hybrid" | "fts-only";
} {
  if (params.provider) {
    return {
      provider: params.provider.id,
      model: params.provider.model,
      searchMode: "hybrid",
    };
  }
  if (params.providerInitialized) {
    return {
      provider: "none",
      model: undefined,
      searchMode: "fts-only",
    };
  }
  return {
    provider: params.requestedProvider,
    model: params.resolveConfiguredModel?.() || undefined,
    searchMode: "hybrid",
  };
}

function collectMemoryStatusAggregate(params: {
  db: Pick<EngineConnection, "prepare"> | undefined;
  sources: Iterable<MemorySource>;
  sourceFilterSql?: string;
  sourceFilterParams?: MemorySource[];
  includeChunkBytes?: boolean;
}): {
  files: number;
  chunks: number;
  sourceCounts: Array<{ source: MemorySource; files: number; chunks: number; chunkBytes?: number }>;
} {
  const totals = { files: 0, chunks: 0 };
  const emptyCounts = { ...totals, ...(params.includeChunkBytes ? { chunkBytes: 0 } : {}) };
  const bySource = new Map<MemorySource, typeof emptyCounts>();
  // Ordinary status uses covering indexes; payload-byte inspection is diagnostic.
  const chunkBytes = params.includeChunkBytes
    ? "COALESCE(SUM(octet_length(text) + octet_length(embedding)), 0)"
    : "NULL";
  const sourceFilterSql = params.sourceFilterSql ?? "";
  const query =
    `SELECT 'files' AS kind, source, COUNT(*) as c, 0 AS bytes FROM memory_index_sources WHERE 1=1${sourceFilterSql} GROUP BY source\n` +
    `UNION ALL\n` +
    `SELECT 'chunks' AS kind, source, COUNT(*) as c, ${chunkBytes} AS bytes FROM memory_index_chunks WHERE 1=1${sourceFilterSql} GROUP BY source`;
  const filterParams = params.sourceFilterParams ?? [];
  const rows = params.db
    ?.prepare(query)
    // SAFETY: Both UNION branches return the declared kind/source, count, and nullable byte total.
    .all(...filterParams, ...filterParams) as StatusAggregateRow[] | undefined;
  for (const row of rows ?? []) {
    const entry = bySource.get(row.source) ?? { ...emptyCounts };
    entry[row.kind] = row.c;
    totals[row.kind] += row.c;
    if (row.kind === "chunks" && row.bytes !== null) {
      entry.chunkBytes = row.bytes;
    }
    bySource.set(row.source, entry);
  }
  return {
    ...totals,
    sourceCounts: Array.from(params.sources, (source) =>
      Object.assign({ source, ...emptyCounts }, bySource.get(source)),
    ),
  };
}
