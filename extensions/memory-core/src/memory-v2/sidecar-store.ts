import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabaseAtPath } from "../memory/manager-db.js";
import { ensureSidecarSchema } from "./sidecar-schema.js";

// Opens (and initializes) the v2 sidecar SQLite database at the given path.
// Reuses the package's existing node:sqlite opener so PRAGMA defaults and
// directory creation behavior stay consistent with the main memory index.
export function openSidecarDatabase(dbPath: string): DatabaseSync {
  const db = openMemoryDatabaseAtPath(dbPath, false);
  ensureSidecarSchema(db);
  return db;
}
