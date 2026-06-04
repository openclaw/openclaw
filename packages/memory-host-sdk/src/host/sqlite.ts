import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "./error-utils.js";
import {
  configureSqliteWalMaintenance,
  type SqliteWalMaintenance,
  type SqliteWalMaintenanceOptions,
} from "./sqlite-wal.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
const sqliteWalMaintenanceByDb = new WeakMap<MemoryDb, SqliteWalMaintenance>();

export interface MemoryStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  iterate(...params: unknown[]): Iterable<unknown>;
}

export interface MemoryDb {
  exec(sql: string): unknown;
  prepare(sql: string): MemoryStatement;
  close(): void;
  loadExtension(path: string): void;
}

type BetterSqlite3Constructor = new (path: string, options?: { readonly?: boolean }) => MemoryDb;

export function requireBetterSqlite3(): BetterSqlite3Constructor {
  try {
    return require("better-sqlite3") as BetterSqlite3Constructor;
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(`SQLite support unavailable (missing better-sqlite3). ${message}`, {
      cause: err,
    });
  }
}

export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(
      `SQLite support is unavailable in this Node runtime (missing node:sqlite). ${message}`,
      { cause: err },
    );
  }
}

export function configureMemorySqliteWalMaintenance(
  db: MemoryDb,
  options?: SqliteWalMaintenanceOptions,
): SqliteWalMaintenance {
  const existing = sqliteWalMaintenanceByDb.get(db);
  if (existing) {
    return existing;
  }
  const maintenance = configureSqliteWalMaintenance(db, options);
  sqliteWalMaintenanceByDb.set(db, maintenance);
  return maintenance;
}

export function closeMemorySqliteWalMaintenance(db: MemoryDb): boolean {
  const maintenance = sqliteWalMaintenanceByDb.get(db);
  if (!maintenance) {
    return true;
  }
  sqliteWalMaintenanceByDb.delete(db);
  return maintenance.close();
}

// Kept for backward-compat: test files use requireNodeSqlite() to create
// in-memory DatabaseSync instances, which satisfy the MemoryDb interface.
export type { DatabaseSync };
