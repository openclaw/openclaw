import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import {
  buildMemoryIndexStrictSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_STATE_TABLE,
} from "./memory-schema-base.js";
import { memorySchemaSource } from "./memory-schema-catalog.js";
import * as provenanceSchema from "./memory-schema-provenance.js";
import {
  ensureMemoryRecallMetadataSchema,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
} from "./memory-schema-recall.js";
import { migrateMemoryIndexStorage } from "./memory-schema-storage-migration.js";
import { memoryTextSearchSchema } from "./memory-search-schema.js";
import {
  admitSqliteMemoryTextSearch,
  backfillMemoryPathFtsRows,
  dropDisabledMemoryFts,
  dropMemoryChunkFtsTriggers,
  dropMemoryPathFtsTriggers,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  reconcileMemoryChunkFtsRows,
  canReuseSqliteSchemaInTransaction,
  getAdmittedSqliteSchemaFacts,
  getSqliteDatabaseAdmission,
  migrateSqliteSchemaToStrict,
  migrateSqliteSchemaToStrictInTransaction,
  publishSqliteDatabaseAdmission,
  runSqliteImmediateTransactionSync,
  stageSqliteTransactionState,
  sqlPublicationAnchor,
  type PostgresSqlConnection,
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
} from "./openclaw-runtime-sqlite.js";
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

type MemoryIndexSchemaAdmission = { ftsAvailable: boolean; repairWriteToken?: string };
const memoryIndexSchemaAdmissionKeys = new WeakMap<
  DatabaseSync,
  SqliteDatabaseAdmissionKey<MemoryIndexSchemaAdmission>
>();

/** Derived-index replacements preserve the admitted memory table contracts. */
export function stageMemoryIndexSchemaExtension(
  db: DatabaseSync | PostgresSqlConnection,
  replacement?: { ftsAvailable: boolean },
): void {
  const key = memoryIndexSchemaAdmissionKeys.get(sqlPublicationAnchor(db));
  const admitted = key && getSqliteDatabaseAdmission(db, key);
  if (!key || !admitted || (replacement && replacement.ftsAvailable !== admitted.ftsAvailable)) {
    return;
  }
  if (
    !stageSqliteTransactionState(sqlPublicationAnchor(db), {
      stage: () => {},
      rollback: () => {},
      commit: () => publishSqliteDatabaseAdmission(db, key, admitted),
    })
  ) {
    throw new Error("Memory schema extensions require a managed transaction");
  }
}

function readMemoryIndexSchemaAdmission(value: unknown): MemoryIndexSchemaAdmission | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ftsAvailable" in value) ||
    typeof value.ftsAvailable !== "boolean"
  ) {
    return undefined;
  }
  return {
    ftsAvailable: value.ftsAvailable,
    ...("repairWriteToken" in value && typeof value.repairWriteToken === "string"
      ? { repairWriteToken: value.repairWriteToken }
      : {}),
  };
}

function memoryIndexSchemaAdmissionKey(
  params: Omit<Parameters<typeof ensureMemoryIndexSchema>[0], "db" | "fresh">,
): SqliteDatabaseAdmissionKey<MemoryIndexSchemaAdmission> {
  return {
    name: `memory.index-schema:${JSON.stringify([
      params.embeddingCacheTable ?? MEMORY_EMBEDDING_CACHE_TABLE,
      params.cacheEnabled,
      params.ftsTable ?? MEMORY_INDEX_FTS_TABLE,
      params.ftsEnabled,
      params.ftsTokenizer ?? "unicode61",
    ])}`,
    schemaDependent: true,
    read: readMemoryIndexSchemaAdmission,
  };
}

/** Reuse completed worker repair only for the same schema, options, and data generation. */
export function readRepairedMemoryIndexSchema(
  params: Parameters<typeof ensureMemoryIndexSchema>[0],
  writeToken: string | undefined,
): { ftsAvailable: boolean } | undefined {
  const key = memoryIndexSchemaAdmissionKey(params);
  const admitted = getSqliteDatabaseAdmission(params.db, key);
  if (writeToken === undefined || admitted?.repairWriteToken !== writeToken) {
    return undefined;
  }
  // A fresh handle can inherit the shared receipt. Later derived-index replacement
  // still needs its local key to preserve schema admission through commit.
  memoryIndexSchemaAdmissionKeys.set(sqlPublicationAnchor(params.db), key);
  return { ftsAvailable: admitted.ftsAvailable };
}

/** The worker supplies successful repair's committed receipt; explicit ensure still repairs imports. */
export function publishRepairedMemoryIndexSchema(
  params: Parameters<typeof ensureMemoryIndexSchema>[0],
  writeToken: string | undefined,
): void {
  const key = memoryIndexSchemaAdmissionKey(params);
  const admitted = getSqliteDatabaseAdmission(params.db, key);
  if (writeToken !== undefined && admitted) {
    publishSqliteDatabaseAdmission(params.db, key, { ...admitted, repairWriteToken: writeToken });
  }
}

function tableColumnInfo(db: DatabaseSync, tableName: string): TableColumnInfo[] {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (
    schema &&
    ![...schema.tables, ...schema.views].some(
      (name) => name.toLowerCase() === tableName.toLowerCase(),
    )
  ) {
    return [];
  }
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
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    return schema.tables.has(tableName);
  }
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
  /**
   * Caller asserts it just created this empty private shadow database.
   * Passing this for an existing database skips required migration checks and repair writes.
   */
  fresh?: true;
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
  const admissionKey = memoryIndexSchemaAdmissionKey(params);
  memoryIndexSchemaAdmissionKeys.set(sqlPublicationAnchor(params.db), admissionKey);
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
    return { ftsAvailable: admitted.ftsAvailable };
  }
  if (
    !params.fresh &&
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
  const tables = params.fresh ? undefined : getAdmittedSqliteSchemaFacts(params.db)?.tables;
  if (
    ![
      MEMORY_INDEX_META_TABLE,
      MEMORY_INDEX_SOURCES_TABLE,
      MEMORY_INDEX_CHUNKS_TABLE,
      MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
      provenanceSchema.MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
      MEMORY_INDEX_STATE_TABLE,
      ...(params.cacheEnabled ? [embeddingCacheTable] : []),
    ].every((table) => tables?.has(table))
  ) {
    params.db.exec(
      buildMemoryIndexStrictSchema({
        embeddingCacheTable,
        includeEmbeddingCache: params.cacheEnabled,
      }),
    );
  }
  if (!params.fresh) {
    migrateMemoryIndexStorage(params.db, { embeddingCacheTable });
    ensureMemoryRecallMetadataSchema(params.db);
  }
  params.db.exec(`
    INSERT OR IGNORE INTO ${MEMORY_INDEX_STATE_TABLE} (id, revision) VALUES (1, 0);
  `);
  if (!params.fresh) {
    migrateMemoryIndexSourcesIdentity(params.db);
  }
  // Migrations can replace these indexes; subsequent FTS/provenance work cannot.
  const indexes = params.fresh ? undefined : getAdmittedSqliteSchemaFacts(params.db)?.indexes;
  if (!params.fresh && indexes?.has("idx_memory_index_chunks_path") !== false) {
    params.db.exec("DROP INDEX IF EXISTS idx_memory_index_chunks_path;");
  }
  if (
    ![
      "idx_memory_index_sources_source",
      "idx_memory_index_chunks_path_source",
      "idx_memory_index_chunks_source",
    ].every((index) => indexes?.has(index))
  ) {
    params.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_index_sources_source
        ON ${MEMORY_INDEX_SOURCES_TABLE}(source);
      CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path_source
        ON ${MEMORY_INDEX_CHUNKS_TABLE}(path, source);
      CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_source
        ON ${MEMORY_INDEX_CHUNKS_TABLE}(source);
    `);
  }
  if (!params.fresh) {
    provenanceSchema.ensureMemoryChunkProvenance(params.db);
  }
  dropDisabledMemoryFts(params.db, ftsTable, params.ftsEnabled);
  if (params.cacheEnabled) {
    const updatedAtIndex =
      embeddingCacheTable === MEMORY_EMBEDDING_CACHE_TABLE
        ? "idx_memory_embedding_cache_updated_at"
        : "idx_embedding_cache_updated_at";
    if (!indexes?.has(updatedAtIndex)) {
      params.db.exec(`
        CREATE INDEX IF NOT EXISTS ${updatedAtIndex}
          ON ${embeddingCacheTable}(updated_at);
      `);
    }
  }
  if (!params.fresh) {
    // Worker admission owns BEGIN, foreign-key policy, and the guarded commit.
    const migrateStrict = params.db.isTransaction
      ? migrateSqliteSchemaToStrictInTransaction
      : migrateSqliteSchemaToStrict;
    const includeEmbeddingCache =
      params.cacheEnabled || tableExists(params.db, embeddingCacheTable);
    migrateStrict(
      params.db,
      buildMemoryIndexStrictSchema({
        embeddingCacheTable,
        includeEmbeddingCache,
      }),
      {
        databaseLabel: "memory index",
        expectedSchema: memorySchemaSource(
          buildMemoryIndexStrictSchema({
            embeddingCacheTable: MEMORY_EMBEDDING_CACHE_TABLE,
            includeEmbeddingCache,
          }),
          embeddingCacheTable,
        ),
      },
    );
  }

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      const search = memoryTextSearchSchema(tokenizer);
      // Deprecated custom FTS tables preserve their body-only contract. The
      // canonical index owns the separate path table and its source triggers.
      if (ftsTable !== MEMORY_INDEX_FTS_TABLE) {
        search.text = { body: { ...search.text!.body!, table: ftsTable } };
      }
      admitSqliteMemoryTextSearch(params.db, search, { fresh: params.fresh });
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
