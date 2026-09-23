import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  MEMORY_INDEX_DERIVED_TABLES,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  openOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import {
  MEMORY_INDEX_STATE_ID,
  memoryDatabaseTableExists as tableExists,
  readMemoryDatabaseRevision,
} from "./manager-db-kernel.js";
import { withMemoryIndexPublishGeneration } from "./manager-index-generation-lease.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";

const MEMORY_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const MEMORY_REINDEX_ENTRY_SUFFIXES = ["-wal", "-shm", "-journal", ""] as const;
const MEMORY_REINDEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_REINDEX_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

function resolveMemoryReindexBaseName(
  databaseBaseName: string,
  entryName: string,
): string | undefined {
  for (const suffix of MEMORY_REINDEX_ENTRY_SUFFIXES) {
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
    const prefix = `${databaseBaseName}.memory-reindex-`;
    if (
      baseName.startsWith(prefix) &&
      MEMORY_REINDEX_UUID_PATTERN.test(baseName.slice(prefix.length))
    ) {
      return baseName;
    }
  }
  return undefined;
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function hasSqliteVecExtension(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT vec_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    return typeof row?.version === "string" && row.version.trim().length > 0;
  } catch {
    return false;
  }
}

/** Reset derived content without replacing the shared agent database or its schema. */
export async function resetMemoryDatabase(params: {
  targetDb: DatabaseSync;
  dbPath: string;
  workspaceDir: string;
  vectorExtensionPath?: string;
}): Promise<boolean> {
  const db = params.targetDb;
  const lock = await waitForMemoryReindexLock(params.dbPath);
  try {
    return await withMemoryWorkspaceLock(params.workspaceDir, async () =>
      withMemoryIndexPublishGeneration(params.dbPath, async () => {
        if (tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE) && !hasSqliteVecExtension(db)) {
          const loaded = await loadSqliteVecExtension({
            db,
            extensionPath: params.vectorExtensionPath,
          });
          if (!loaded.ok) {
            throw new Error(
              `Memory reset requires sqlite-vec to clear the vector index: ${loaded.error}`,
            );
          }
        }
        return runSqliteImmediateTransactionSync(db, () => {
          const tables = MEMORY_INDEX_DERIVED_TABLES.filter((table) =>
            tableExists(db, "main", table),
          );
          if (
            !tables.some(
              (table) =>
                table !== MEMORY_INDEX_STATE_TABLE &&
                db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(),
            )
          ) {
            return false;
          }
          const revision = readMemoryDatabaseRevision(db);
          const schema = tables.flatMap(
            (table) =>
              db
                .prepare(
                  "SELECT type, name, sql FROM main.sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY name",
                )
                // SAFETY: SQLite's catalog has text type/name/sql; the query excludes null SQL.
                .all(table) as Array<{ type: string; name: string; sql: string }>,
          );
          // Drop triggers before their targets; recreate every table before its indexes/triggers.
          // Keeping exact FTS/vector definitions also protects already-open manager handles.
          for (const entry of schema.filter((candidate) => candidate.type === "trigger")) {
            db.exec(`DROP TRIGGER "${entry.name.replaceAll('"', '""')}"`);
          }
          for (const table of tables) {
            db.exec(`DROP TABLE main.${table}`);
          }
          for (const type of ["table", "index", "trigger"]) {
            for (const entry of schema.filter((candidate) => candidate.type === type)) {
              db.exec(entry.sql);
            }
          }
          // Missing metadata requests a rebuild; never reuse an old revision (ABA).
          db.prepare(`INSERT INTO ${MEMORY_INDEX_STATE_TABLE} (id, revision) VALUES (?, ?)`).run(
            MEMORY_INDEX_STATE_ID,
            revision + 1,
          );
          return true;
        });
      }),
    );
  } finally {
    await lock.release();
  }
}

/** Remove one closed shadow memory database and its journal-mode sidecars. */
export async function removeMemoryDatabaseFiles(dbPath: string): Promise<void> {
  for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
    await fs.rm(`${dbPath}${suffix}`, { force: true });
  }
}

/** Remove crash-left shadows while the caller owns the reindex lease. */
export async function cleanupAgedMemoryReindexTempFiles(
  dbPath: string,
  nowMs = Date.now(),
): Promise<void> {
  if (!(await isRegularFile(dbPath))) {
    return;
  }
  const dir = path.dirname(dbPath);
  const databaseBaseName = path.basename(dbPath);
  const shadowBaseNames = new Set<string>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const shadowBaseName = resolveMemoryReindexBaseName(databaseBaseName, entry.name);
    if (shadowBaseName) {
      shadowBaseNames.add(shadowBaseName);
    }
  }

  for (const shadowBaseName of shadowBaseNames) {
    const filePaths = MEMORY_DATABASE_FILE_SUFFIXES.map((suffix) =>
      path.join(dir, `${shadowBaseName}${suffix}`),
    );
    const stats: Stats[] = [];
    let hasUnknownFileState = false;
    for (const filePath of filePaths) {
      try {
        stats.push(await fs.stat(filePath));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          hasUnknownFileState = true;
          break;
        }
      }
    }
    if (hasUnknownFileState || stats.length === 0) {
      continue;
    }
    if (nowMs - Math.max(...stats.map((stat) => stat.mtimeMs)) < MEMORY_REINDEX_ORPHAN_MIN_AGE_MS) {
      continue;
    }
    for (const filePath of filePaths) {
      try {
        await fs.rm(filePath, { force: true });
      } catch {}
    }
  }
}

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  runMaintenance?: (operation: () => boolean) => boolean,
): DatabaseSync {
  const db = openNodeSqliteDatabase(dbPath, { allowExtension });
  try {
    configureMemorySqliteWalMaintenance(db, {
      busyTimeoutMs: 5000,
      databasePath: dbPath,
      ...(runMaintenance ? { runMaintenance } : {}),
    });
    return db;
  } catch (err) {
    try {
      closeMemorySqliteWalMaintenance(db);
      db.close();
    } catch {}
    throw err;
  }
}

function openUninitializedMemoryDatabase(allowExtension: boolean) {
  const database = openNodeSqliteDatabase(":memory:", { allowExtension });
  try {
    ensureMemoryIndexSchema({ cacheEnabled: true, db: database, ftsEnabled: true });
    database.exec("PRAGMA query_only = ON");
    return { db: database, release: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Open an existing memory index through the agent database query-only owner. */
export function openMemoryDatabaseReadOnlyAtPath(
  dbPath: string,
  allowExtension: boolean,
  agentId: string,
) {
  const opened = openOpenClawAgentDatabaseReadOnly({ agentId, path: dbPath }, { allowExtension });
  if (!opened.found) {
    if (opened.reason === "database-missing") {
      return openUninitializedMemoryDatabase(allowExtension);
    }
    throw new Error(`Memory index database schema is missing: ${dbPath}`);
  }
  const { database } = opened;
  if (!tableExists(database.db, "main", MEMORY_INDEX_STATE_TABLE)) {
    database.close();
    return openUninitializedMemoryDatabase(allowExtension);
  }
  return { db: database.db, release: database.close };
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  if (db.isOpen) {
    db.close();
  }
}
