import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDatabaseAtPath } from "../memory/manager-db.js";
import { ensureSidecarSchema } from "./sidecar-schema.js";

// Canonical on-disk path for the v2 sidecar, anchored at the workspace's
// memory directory. Kept as a single constant so ingest and rerank never
// drift on the filename or the layout.
export const SIDECAR_DB_RELATIVE_PATH = "memory/v2-sidecar.db";

// Opens (and initializes) the v2 sidecar SQLite database at the given path.
// Reuses the package's existing node:sqlite opener so PRAGMA defaults and
// directory creation behavior stay consistent with the main memory index.
export function openSidecarDatabase(dbPath: string): DatabaseSync {
  const db = openMemoryDatabaseAtPath(dbPath, false);
  ensureSidecarSchema(db);
  return db;
}

// Builds a workspace-keyed opener with its own per-workspace cache. One
// instance per plugin activation; shared between ingest and rerank so both
// reuse the same DatabaseSync per workspace path.
export function createSidecarOpener(): (workspaceDir: string) => DatabaseSync {
  const cache = new Map<string, DatabaseSync>();
  return (workspaceDir) => {
    const cached = cache.get(workspaceDir);
    if (cached) {
      return cached;
    }
    const db = openSidecarDatabase(path.join(workspaceDir, SIDECAR_DB_RELATIVE_PATH));
    cache.set(workspaceDir, db);
    return db;
  };
}
