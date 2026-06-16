// Memory Core plugin module implements manager db behavior.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  ensureOpenClawAgentDatabaseSchema,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";

const MEMORY_REINDEX_SCHEMA = "memory_reindex";
const MEMORY_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

function readTableSql(db: DatabaseSync, schema: string, tableName: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" && row.sql.trim() ? row.sql : null;
}

function replaceVirtualTable(params: {
  db: DatabaseSync;
  tableName: "chunks_fts" | "chunks_vec";
  columns: string;
  dropWhenSourceMissing?: boolean;
}): void {
  const { db, tableName, columns } = params;
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, tableName);
  if (!createSql) {
    if (params.dropWhenSourceMissing !== false) {
      db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
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

/** Publish a completed shadow memory index without replacing the shared agent database file. */
export function publishMemoryDatabaseTables(params: {
  targetDb: DatabaseSync;
  sourcePath: string;
  metaKey: string;
}): void {
  params.targetDb.prepare(`ATTACH DATABASE ? AS ${MEMORY_REINDEX_SCHEMA}`).run(params.sourcePath);
  try {
    runSqliteImmediateTransactionSync(params.targetDb, () => {
      params.targetDb.prepare("DELETE FROM main.meta WHERE key = ?").run(params.metaKey);
      params.targetDb
        .prepare(
          `INSERT INTO main.meta (key, value)
           SELECT key, value FROM ${MEMORY_REINDEX_SCHEMA}.meta WHERE key = ?`,
        )
        .run(params.metaKey);

      params.targetDb.exec(`
        DELETE FROM main.files;
        INSERT INTO main.files (path, source, hash, mtime, size)
        SELECT path, source, hash, mtime, size FROM ${MEMORY_REINDEX_SCHEMA}.files;

        DELETE FROM main.chunks;
        INSERT INTO main.chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        )
        SELECT
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        FROM ${MEMORY_REINDEX_SCHEMA}.chunks;
      `);

      if (tableExists(params.targetDb, MEMORY_REINDEX_SCHEMA, "embedding_cache")) {
        params.targetDb.exec(`
          DELETE FROM main.embedding_cache;
          INSERT INTO main.embedding_cache (
            provider, model, provider_key, hash, embedding, dims, updated_at
          )
          SELECT provider, model, provider_key, hash, embedding, dims, updated_at
          FROM ${MEMORY_REINDEX_SCHEMA}.embedding_cache;
        `);
      }

      replaceVirtualTable({
        db: params.targetDb,
        tableName: "chunks_fts",
        columns: "text, id, path, source, model, start_line, end_line",
      });
      replaceVirtualTable({
        db: params.targetDb,
        tableName: "chunks_vec",
        columns: "id, embedding",
        // A vector-disabled connection may not have sqlite-vec loaded and cannot
        // drop an old virtual table. It is unused and can remain until vec loads.
        dropWhenSourceMissing: false,
      });
    });
  } finally {
    params.targetDb.exec(`DETACH DATABASE ${MEMORY_REINDEX_SCHEMA}`);
  }
}

/** Remove one closed shadow memory database and its journal-mode sidecars. */
export function removeMemoryDatabaseFiles(dbPath: string): void {
  for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  agentId?: string,
): DatabaseSync {
  ensureDir(path.dirname(dbPath));
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension });
  try {
    configureMemorySqliteWalMaintenance(db, {
      busyTimeoutMs: 5000,
      databasePath: dbPath,
    });
    if (agentId) {
      ensureOpenClawAgentDatabaseSchema(db, { agentId, path: dbPath, register: true });
    }
    return db;
  } catch (err) {
    try {
      closeMemorySqliteWalMaintenance(db);
      db.close();
    } catch {}
    throw err;
  }
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
}
