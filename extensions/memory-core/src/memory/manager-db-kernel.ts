import type { DatabaseSync } from "node:sqlite";
import {
  dropMemoryChunkFtsTriggers,
  dropMemoryPathFtsTriggers,
  ensureMemoryChunkFtsTriggers,
  ensureMemoryChunkProvenance,
  ensureMemoryRecallMetadataSchema,
  ensureMemoryPathFtsTriggers,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  rebuildMemoryChunkFts,
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

function replaceMemoryVectorTable(db: DatabaseSync): void {
  const tableName = "memory_index_chunks_vec";
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, tableName);
  if (!createSql) {
    // A vector-disabled connection may not have sqlite-vec loaded and cannot
    // drop an old virtual table. Missing vector metadata forces a strict
    // rebuild before that table can be queried again.
    try {
      db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
    } catch {}
    return;
  }
  db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
  db.exec(createSql);
  db.exec(
    `INSERT INTO main.${tableName} (id, embedding) ` +
      `SELECT id, embedding FROM ${MEMORY_REINDEX_SCHEMA}.${tableName}`,
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
        dropMemoryChunkFtsTriggers(params.targetDb);
        params.targetDb
          .prepare("DELETE FROM main.memory_index_meta WHERE key = ?")
          .run(params.metaKey);
        params.targetDb
          .prepare(
            `INSERT INTO main.memory_index_meta (key, value)
           SELECT key, value FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_meta WHERE key = ?`,
          )
          .run(params.metaKey);

        params.targetDb.exec(
          Object.entries({
            memory_index_sources: "id, path, source, hash, mtime, size",
            memory_index_chunks:
              "chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at",
            [MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE]:
              "chunk_id, importance, triggers, project_key",
            memory_index_chunk_provenance:
              "chunk_id, origin_class, session_kind, observed_at, supersedes_key",
          })
            .map(
              ([table, columns]) =>
                `DELETE FROM main.${table};\n` +
                `INSERT INTO main.${table} (${columns})\n` +
                `SELECT ${columns} FROM ${MEMORY_REINDEX_SCHEMA}.${table};`,
            )
            .join("\n"),
        );

        for (const table of [MEMORY_INDEX_FTS_TABLE, MEMORY_INDEX_PATHS_FTS_TABLE]) {
          const createSql = readTableSql(params.targetDb, MEMORY_REINDEX_SCHEMA, table);
          params.targetDb.exec(`DROP TABLE IF EXISTS main.${table}`);
          if (!createSql) {
            continue;
          }
          params.targetDb.exec(createSql);
          if (table === MEMORY_INDEX_FTS_TABLE) {
            rebuildMemoryChunkFts(params.targetDb, table);
            ensureMemoryChunkFtsTriggers(params.targetDb);
          } else {
            // Rebuild from the copied stable source ids while row triggers are suspended.
            params.targetDb.exec(
              `INSERT INTO main.${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source) ` +
                `SELECT id, path, source FROM main.memory_index_sources`,
            );
          }
        }
        if (publishesPathFts) {
          ensureMemoryPathFtsTriggers(params.targetDb);
        }
        replaceMemoryVectorTable(params.targetDb);
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
