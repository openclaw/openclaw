import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import {
  buildMemoryIndexStrictSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_STATE_TABLE,
} from "./memory-schema-base.js";
import {
  backfillMemoryPathFtsRows,
  dropDisabledMemoryFts,
  dropMemoryChunkFtsTriggers,
  dropMemoryPathFtsTriggers,
  ensureMemoryChunkFtsSchema,
  ensureMemoryPathFtsSchema,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  reconcileMemoryChunkFtsRows,
} from "./memory-schema-fts.js";
import * as provenanceSchema from "./memory-schema-provenance.js";
import { ensureMemoryRecallMetadataSchema } from "./memory-schema-recall.js";
import { migrateMemoryIndexStorage } from "./memory-schema-storage-migration.js";
import {
  canReuseSqliteSchemaInTransaction,
  getSqliteDatabaseAdmission,
  migrateSqliteSchemaToStrict,
  migrateSqliteSchemaToStrictInTransaction,
  publishSqliteDatabaseAdmission,
  runSqliteImmediateTransactionSync,
  type SqliteDatabaseAdmissionKey,
} from "./openclaw-runtime-sqlite.js";
export {
  markInvalidImportedMemoryEmbeddings,
  migrateMemoryIndexStorage,
  registerMemoryEmbeddingMigrationFunctions,
} from "./memory-schema-storage-migration.js";
export {
  ensureMemoryRecallMetadataSchema,
  hasLegacyMemoryRecallMetadataColumns,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
} from "./memory-schema-recall.js";

export {
  dropMemoryChunkFtsTriggers,
  dropMemoryPathFtsTriggers,
  ensureMemoryChunkFtsTriggers,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
  MEMORY_CHUNK_FTS_TRIGGER_DEFINITIONS,
  rebuildMemoryChunkFts,
} from "./memory-schema-fts.js";
export {
  ensureMemoryChunkProvenance,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
} from "./memory-schema-provenance.js";
export {
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  MEMORY_INDEX_DERIVED_TABLES,
} from "./memory-schema-base.js";

// SQLite schema setup for builtin memory index, embedding cache, and FTS.

const LEGACY_MEMORY_INDEX_SOURCE_COLUMNS = ["path", "source", "hash", "mtime", "size"] as const;
const MEMORY_INDEX_SOURCE_COLUMNS = ["id", ...LEGACY_MEMORY_INDEX_SOURCE_COLUMNS] as const;
const MEMORY_INDEX_SOURCE_COLUMN_TYPES = new Map<string, string>([
  ["id", "INTEGER"],
  ["path", "TEXT"],
  ["source", "TEXT"],
  ["hash", "TEXT"],
  ["mtime", "REAL"],
  ["size", "INTEGER"],
]);

type TableColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  defaultValue: string | null;
  hidden: number;
};

type MemoryIndexSchemaAdmission = { ftsAvailable: boolean };

function readMemoryIndexSchemaAdmission(value: unknown): MemoryIndexSchemaAdmission | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ftsAvailable" in value) ||
    typeof value.ftsAvailable !== "boolean"
  ) {
    return undefined;
  }
  return { ftsAvailable: value.ftsAvailable };
}

function tableColumnInfo(db: DatabaseSync, tableName: string): TableColumnInfo[] {
  const rows = db.prepare(`PRAGMA main.table_xinfo(${tableName})`).all() as Array<{
    name?: unknown;
    type?: unknown;
    notnull?: unknown;
    pk?: unknown;
    dflt_value?: unknown;
    hidden?: unknown;
  }>;
  return rows.flatMap((row) =>
    typeof row.name === "string" && typeof row.type === "string"
      ? [
          {
            name: row.name,
            type: row.type.toUpperCase(),
            notnull: Number(row.notnull ?? 0),
            pk: Number(row.pk ?? 0),
            defaultValue: typeof row.dflt_value === "string" ? row.dflt_value : null,
            hidden: Number(row.hidden ?? 0),
          },
        ]
      : [],
  );
}

function tableHasExactColumns(
  db: DatabaseSync,
  tableName: string,
  expected: readonly string[],
  preparedColumns?: TableColumnInfo[],
): boolean {
  const columns = new Set(
    (preparedColumns ?? tableColumnInfo(db, tableName)).map((row) => row.name),
  );
  return columns.size === expected.length && expected.every((column) => columns.has(column));
}

function tableHasPrimaryKey(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
  preparedColumns?: TableColumnInfo[],
): boolean {
  const columns = (preparedColumns ?? tableColumnInfo(db, tableName))
    .filter((row) => row.pk > 0)
    .toSorted((left, right) => left.pk - right.pk)
    .map((row) => row.name);
  return (
    columns.length === expectedColumns.length &&
    columns.every((column, index) => column === expectedColumns[index])
  );
}

function tableHasUniqueIndex(
  db: DatabaseSync,
  tableName: string,
  expectedColumns: readonly string[],
): boolean {
  const indexes = db
    .prepare(`SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1`)
    .all(tableName) as Array<{ name?: unknown; partial?: unknown }>;
  if (indexes.length !== 1) {
    return false;
  }
  return indexes.some((index) => {
    if (typeof index.name !== "string" || Number(index.partial ?? 0) !== 0) {
      return false;
    }
    const columns = db
      .prepare(
        `SELECT cid, name, coll, "desc" AS sort_desc, key FROM pragma_index_xinfo(?) ORDER BY seqno`,
      )
      .all(index.name)
      .filter((row) => Number((row as { key?: unknown }).key ?? 0) === 1) as Array<{
      cid?: unknown;
      name?: unknown;
      coll?: unknown;
      sort_desc?: unknown;
    }>;
    return (
      columns.length === expectedColumns.length &&
      columns.every(
        (column, columnIndex) =>
          Number(column.cid ?? -1) >= 0 &&
          column.name === expectedColumns[columnIndex] &&
          column.coll === "BINARY" &&
          Number(column.sort_desc ?? 0) === 0,
      )
    );
  });
}

function tableHasNoDeclaredCollations(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" && !/\bCOLLATE\b/iu.test(row.sql);
}

function tableHasSourceColumnContract(
  db: DatabaseSync,
  nullableColumn?: string,
  preparedColumns?: TableColumnInfo[],
): boolean {
  return (preparedColumns ?? tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE)).every(
    (column) =>
      (column.type === MEMORY_INDEX_SOURCE_COLUMN_TYPES.get(column.name) ||
        (column.name === "mtime" && column.type === "INTEGER")) &&
      column.defaultValue === (column.name === "source" ? "'memory'" : null) &&
      column.hidden === 0 &&
      (column.name === nullableColumn || column.notnull === 1),
  );
}

function tableHasIntegerRowIdPrimaryKey(
  db: DatabaseSync,
  preparedColumns?: TableColumnInfo[],
): boolean {
  const idColumn = (preparedColumns ?? tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE)).find(
    (column) => column.name === "id",
  );
  if (
    idColumn?.type !== "INTEGER" ||
    !tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, ["id"], preparedColumns)
  ) {
    return false;
  }
  // INTEGER PRIMARY KEY DESC and WITHOUT ROWID tables expose a PK index;
  // neither gives FTS the stable rowid alias this schema requires.
  const primaryKeyIndex = db
    .prepare(`SELECT 1 AS found FROM pragma_index_list(?) WHERE origin = 'pk' LIMIT 1`)
    .get(MEMORY_INDEX_SOURCES_TABLE) as { found?: unknown } | undefined;
  return primaryKeyIndex?.found !== 1;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { found?: unknown } | undefined;
  return row?.found === 1;
}

/** Upgrade canonical memory sources to stable integer identities. */
export function migrateMemoryIndexSourcesIdentity(db: DatabaseSync): void {
  if (!tableExists(db, MEMORY_INDEX_SOURCES_TABLE)) {
    return;
  }
  // These predicates precede all migration writes and share the same transaction snapshot.
  const columns = canReuseSqliteSchemaInTransaction(db)
    ? tableColumnInfo(db, MEMORY_INDEX_SOURCES_TABLE)
    : undefined;
  if (tableHasExactColumns(db, MEMORY_INDEX_SOURCES_TABLE, MEMORY_INDEX_SOURCE_COLUMNS, columns)) {
    if (
      tableHasSourceColumnContract(db, "id", columns) &&
      tableHasIntegerRowIdPrimaryKey(db, columns) &&
      tableHasNoDeclaredCollations(db, MEMORY_INDEX_SOURCES_TABLE) &&
      tableHasUniqueIndex(db, MEMORY_INDEX_SOURCES_TABLE, ["path", "source"])
    ) {
      return;
    }
    throw new Error("canonical memory source identity schema is invalid");
  }
  if (
    !tableHasExactColumns(
      db,
      MEMORY_INDEX_SOURCES_TABLE,
      LEGACY_MEMORY_INDEX_SOURCE_COLUMNS,
      columns,
    )
  ) {
    throw new Error("canonical memory source identity schema is invalid");
  }
  const hasPathPrimaryKey = tableHasPrimaryKey(db, MEMORY_INDEX_SOURCES_TABLE, ["path"], columns);
  const hasPathSourcePrimaryKey = tableHasPrimaryKey(
    db,
    MEMORY_INDEX_SOURCES_TABLE,
    ["path", "source"],
    columns,
  );
  if (!hasPathPrimaryKey && !hasPathSourcePrimaryKey) {
    throw new Error("canonical memory source identity schema is invalid");
  }
  if (!tableHasSourceColumnContract(db, hasPathPrimaryKey ? "path" : undefined, columns)) {
    throw new Error("canonical memory source identity schema is invalid");
  }

  const rebuildsPathFts = tableExists(db, MEMORY_INDEX_PATHS_FTS_TABLE);
  db.exec("SAVEPOINT migrate_memory_index_sources_identity");
  try {
    dropMemoryPathFtsTriggers(db);
    db.exec(`
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_insert;
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_update;
      DROP TRIGGER IF EXISTS memory_index_sources_revision_after_delete;

      ALTER TABLE ${MEMORY_INDEX_SOURCES_TABLE}
        RENAME TO memory_index_sources_identity_migration;
      CREATE TABLE ${MEMORY_INDEX_SOURCES_TABLE} (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime REAL NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source)
      ) STRICT;
      INSERT INTO ${MEMORY_INDEX_SOURCES_TABLE} (id, path, source, hash, mtime, size)
      SELECT rowid, path, source, hash, mtime, size
      FROM memory_index_sources_identity_migration;
      DROP TABLE memory_index_sources_identity_migration;
    `);
    if (rebuildsPathFts) {
      db.exec(`
        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE};
        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        SELECT id, path, source FROM ${MEMORY_INDEX_SOURCES_TABLE};
      `);
      ensureMemoryPathFtsTriggers(db);
    }
    db.exec("RELEASE migrate_memory_index_sources_identity");
  } catch (err) {
    db.exec("ROLLBACK TO migrate_memory_index_sources_identity");
    db.exec("RELEASE migrate_memory_index_sources_identity");
    throw err;
  }
}

/** Ensure canonical memory index tables and the optional FTS table exist. */
export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  /** @deprecated Omit to use the canonical memory cache table. */
  embeddingCacheTable?: string;
  cacheEnabled: boolean;
  /** @deprecated Omit to use the canonical memory FTS table. */
  ftsTable?: string;
  ftsEnabled: boolean;
  ftsTokenizer?: "unicode61" | "trigram";
}): { ftsAvailable: boolean; ftsError?: string } {
  const embeddingCacheTable = params.embeddingCacheTable ?? MEMORY_EMBEDDING_CACHE_TABLE;
  const ftsTable = params.ftsTable ?? MEMORY_INDEX_FTS_TABLE;
  const tokenizer = params.ftsTokenizer ?? "unicode61";
  const admissionKey: SqliteDatabaseAdmissionKey<MemoryIndexSchemaAdmission> = {
    name: `memory.index-schema:${JSON.stringify([
      embeddingCacheTable,
      params.cacheEnabled,
      ftsTable,
      params.ftsEnabled,
      tokenizer,
    ])}`,
    schemaDependent: true,
    read: readMemoryIndexSchemaAdmission,
  };
  const admitted = getSqliteDatabaseAdmission(params.db, admissionKey);
  if (admitted) {
    provenanceSchema.backfillMemoryChunkProvenance(params.db);
    if (admitted.ftsAvailable) {
      try {
        const reconcile = () => {
          reconcileMemoryChunkFtsRows(params.db, ftsTable);
          if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
            backfillMemoryPathFtsRows(params.db);
          }
        };
        if (params.db.isTransaction) {
          reconcile();
        } else {
          runSqliteImmediateTransactionSync(params.db, reconcile);
        }
      } catch (err) {
        if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
          dropMemoryChunkFtsTriggers(params.db);
          dropMemoryPathFtsTriggers(params.db);
        }
        return { ftsAvailable: false, ftsError: formatErrorMessage(err) };
      }
    }
    return admitted;
  }
  if (
    tableHasExactColumns(params.db, "meta", ["key", "value"]) &&
    tableHasExactColumns(params.db, "files", ["path", "source", "hash", "mtime", "size"]) &&
    tableHasExactColumns(params.db, "chunks", [
      "id",
      "path",
      "source",
      "start_line",
      "end_line",
      "hash",
      "model",
      "text",
      "embedding",
      "updated_at",
    ])
  ) {
    throw new Error(
      "Retired memory index format detected. Preserve a complete copy of your state and configuration, then use OpenClaw 2026.9.7 to migrate a compatible copy of this index before retrying the upgrade.",
    );
  }
  params.db.exec(
    buildMemoryIndexStrictSchema({
      embeddingCacheTable,
      includeEmbeddingCache: params.cacheEnabled,
    }),
  );
  migrateMemoryIndexStorage(params.db, { embeddingCacheTable });
  ensureMemoryRecallMetadataSchema(params.db);
  params.db.exec(`
    INSERT OR IGNORE INTO ${MEMORY_INDEX_STATE_TABLE} (id, revision) VALUES (1, 0);
  `);
  migrateMemoryIndexSourcesIdentity(params.db);
  params.db.exec(`
    ${[MEMORY_INDEX_SOURCES_TABLE, MEMORY_INDEX_CHUNKS_TABLE]
      .flatMap((table) =>
        ["insert", "update", "delete"].map(
          (event) => `CREATE TRIGGER IF NOT EXISTS ${table}_revision_after_${event}
            AFTER ${event.toUpperCase()} ON ${table}
            BEGIN
              UPDATE ${MEMORY_INDEX_STATE_TABLE} SET revision = revision + 1 WHERE id = 1;
            END;`,
        ),
      )
      .join("\n")}

    CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
      ON ${MEMORY_INDEX_SOURCES_TABLE}(source);
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(path, source);
    DROP INDEX IF EXISTS idx_memory_index_chunks_path;
    CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
      ON ${MEMORY_INDEX_CHUNKS_TABLE}(source);
  `);
  provenanceSchema.ensureMemoryChunkProvenance(params.db);
  dropDisabledMemoryFts(params.db, ftsTable, params.ftsEnabled);
  if (params.cacheEnabled) {
    const updatedAtIndex =
      embeddingCacheTable === MEMORY_EMBEDDING_CACHE_TABLE
        ? "idx_memory_embedding_cache_updated_at"
        : "idx_embedding_cache_updated_at";
    params.db.exec(`
      CREATE INDEX IF NOT EXISTS ${updatedAtIndex}
        ON ${embeddingCacheTable}(updated_at);
    `);
  }
  // Worker admission owns BEGIN, foreign-key policy, and the guarded commit.
  const migrateStrict = params.db.isTransaction
    ? migrateSqliteSchemaToStrictInTransaction
    : migrateSqliteSchemaToStrict;
  migrateStrict(
    params.db,
    buildMemoryIndexStrictSchema({
      embeddingCacheTable,
      includeEmbeddingCache: params.cacheEnabled || tableExists(params.db, embeddingCacheTable),
    }),
    { databaseLabel: "memory index" },
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      const tokenizeClause = tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
      ensureMemoryChunkFtsSchema({ db: params.db, ftsTable, tokenizeClause });
      // Deprecated custom FTS tables preserve their body-only contract. The
      // canonical index owns the separate path table and its source triggers.
      if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
        ensureMemoryPathFtsSchema({ db: params.db, tokenizeClause });
      }
      ftsAvailable = true;
    } catch (err) {
      if (ftsTable === MEMORY_INDEX_FTS_TABLE) {
        dropMemoryChunkFtsTriggers(params.db);
        dropMemoryPathFtsTriggers(params.db);
      }
      ftsError = formatErrorMessage(err);
    }
  }

  if (!params.ftsEnabled || ftsAvailable) {
    publishSqliteDatabaseAdmission(params.db, admissionKey, { ftsAvailable });
  }
  return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
}
