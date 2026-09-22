import type { DatabaseSync } from "node:sqlite";
import {
  dropMemoryPathFtsTriggers,
  ensureMemoryChunkProvenance,
  ensureMemoryRecallMetadataSchema,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { markMemoryVectorIndexClean } from "./manager-vector-rebuild-state.js";

const MEMORY_REINDEX_SCHEMA = "memory_reindex";
export const MEMORY_INDEX_STATE_ID = 1;

function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row?.ok === 1;
}

export { tableExists as memoryDatabaseTableExists };

function readTableSql(db: DatabaseSync, schema: string, tableName: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return typeof row?.sql === "string" && row.sql.trim() ? row.sql : null;
}

export function readMemoryDatabaseRevision(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT revision FROM memory_index_state WHERE id = ?")
    .get(MEMORY_INDEX_STATE_ID);
  if (typeof row?.revision !== "number" || !Number.isSafeInteger(row.revision)) {
    throw new Error("Memory index revision is missing or invalid");
  }
  return row.revision;
}

export class MemoryIndexRevisionConflictError extends Error {
  override name = "MemoryIndexRevisionConflictError";
}

function replaceVirtualTable(params: {
  db: DatabaseSync;
  tableName: "memory_index_chunks_fts" | "memory_index_chunks_vec";
  columns: string;
  ignoreDropErrorWhenSourceMissing?: boolean;
}): void {
  const { db, tableName, columns } = params;
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, tableName);
  if (!createSql) {
    try {
      db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
    } catch (err) {
      if (!params.ignoreDropErrorWhenSourceMissing) {
        throw err;
      }
    }
    return;
  }
  db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
  db.exec(createSql);
  db.exec(
    `INSERT INTO main.${tableName} (${columns}) ` +
      `SELECT ${columns} FROM ${MEMORY_REINDEX_SCHEMA}.${tableName}`,
  );
}

function replaceMemoryPathFtsTable(db: DatabaseSync): void {
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, MEMORY_INDEX_PATHS_FTS_TABLE);
  db.exec(`DROP TABLE IF EXISTS main.${MEMORY_INDEX_PATHS_FTS_TABLE}`);
  if (!createSql) {
    return;
  }
  db.exec(createSql);
  // Bulk publication already suspends row triggers. Rebuild from the copied
  // stable source ids so later singleton deletes remain direct rowid lookups.
  db.exec(
    `INSERT INTO main.${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source) ` +
      `SELECT id, path, source FROM main.memory_index_sources`,
  );
}

/** The native publication owner receives prepared connection and source facts. */
type MemoryDatabasePublication = {
  targetDb: DatabaseSync;
  sourcePath: string;
  metaKey: string;
  expectedRevision: number;
  onBegin?: () => void;
  withCommit?: (commit: () => void) => void;
  vectorIndexComplete?: boolean;
};

/** The admitted connection owns ATTACH, atomic replacement, COMMIT and DETACH. */
export function publishMemoryDatabaseTables(params: MemoryDatabasePublication): void {
  ensureMemoryRecallMetadataSchema(params.targetDb);
  // Existing pre-provenance databases need this before the publication writes it.
  ensureMemoryChunkProvenance(params.targetDb);
  // Admission precedes ATTACH; no shadow attachment or transaction crosses an await.
  params.targetDb.prepare(`ATTACH DATABASE ? AS ${MEMORY_REINDEX_SCHEMA}`).run(params.sourcePath);
  try {
    runSqliteImmediateTransactionSync(
      params.targetDb,
      () => {
        params.onBegin?.();
        const liveRevision = readMemoryDatabaseRevision(params.targetDb);
        if (liveRevision !== params.expectedRevision) {
          throw new MemoryIndexRevisionConflictError(
            `Memory index changed while full reindex was building ` +
              `(expected revision ${params.expectedRevision}, found ${liveRevision}); retry the full reindex.`,
          );
        }
        const publishesPathFts = tableExists(
          params.targetDb,
          MEMORY_REINDEX_SCHEMA,
          MEMORY_INDEX_PATHS_FTS_TABLE,
        );
        // Bulk source replacement must not fire one FTS5 scan per old row.
        // Restore the schema-owned triggers only after the derived table is replaced.
        dropMemoryPathFtsTriggers(params.targetDb);
        params.targetDb
          .prepare("DELETE FROM main.memory_index_meta WHERE key = ?")
          .run(params.metaKey);
        params.targetDb
          .prepare(
            `INSERT INTO main.memory_index_meta (key, value)
           SELECT key, value FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_meta WHERE key = ?`,
          )
          .run(params.metaKey);

        params.targetDb.exec(`
        DELETE FROM main.memory_index_sources;
        INSERT INTO main.memory_index_sources (id, path, source, hash, mtime, size)
        SELECT id, path, source, hash, mtime, size
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_sources;

        DELETE FROM main.memory_index_chunks;
        INSERT INTO main.memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        )
        SELECT
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_chunks;

        DELETE FROM main.${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE};
        INSERT INTO main.${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE} (
          chunk_id, importance, triggers, project_key
        )
        SELECT chunk_id, importance, triggers, project_key
        FROM ${MEMORY_REINDEX_SCHEMA}.${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE};

        DELETE FROM main.memory_index_chunk_provenance;
        INSERT INTO main.memory_index_chunk_provenance (
          chunk_id, origin_class, session_kind, observed_at, supersedes_key
        )
        SELECT chunk_id, origin_class, session_kind, observed_at, supersedes_key
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_chunk_provenance;
      `);

        replaceVirtualTable({
          db: params.targetDb,
          tableName: "memory_index_chunks_fts",
          columns: "text, id, path, source, model, start_line, end_line",
        });
        replaceMemoryPathFtsTable(params.targetDb);
        if (publishesPathFts) {
          ensureMemoryPathFtsTriggers(params.targetDb);
        }
        replaceVirtualTable({
          db: params.targetDb,
          tableName: "memory_index_chunks_vec",
          columns: "id, embedding",
          // A vector-disabled connection may not have sqlite-vec loaded and cannot
          // drop an old virtual table. Missing vector metadata forces a strict
          // rebuild before that table can be queried again.
          ignoreDropErrorWhenSourceMissing: true,
        });
        if (params.vectorIndexComplete) {
          markMemoryVectorIndexClean(params.targetDb);
        }
      },
      { withCommit: params.withCommit },
    );
  } finally {
    params.targetDb.exec(`DETACH DATABASE ${MEMORY_REINDEX_SCHEMA}`);
  }
}
