// Public SQLite WAL maintenance facade for memory database callers.

export {
  DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
  DEFAULT_SQLITE_WAL_CHECKPOINT_INTERVAL_MS,
  DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS,
  configureSqliteConnectionPragmas,
  configureSqliteWalMaintenance,
} from "./openclaw-runtime-io.js";
export type {
  SqliteConnectionPragmaOptions,
  SqliteWalMaintenance,
  SqliteWalMaintenanceOptions,
} from "./openclaw-runtime-io.js";
