import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { isPathInside } from "../../infra/path-guards.js";
import { setSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { readSqliteUserVersion } from "../../infra/sqlite-user-version.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../../infra/sqlite-wal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";

const AUTH_PROFILE_READ_HANDLE_CAP = 64;
const AUTH_PROFILE_READ_IDLE_MS = 30 * 60_000;
type AuthProfileReadHandle = {
  db: DatabaseSync;
  ready: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};
const authProfileReadDatabases = new Map<string, AuthProfileReadHandle>();
let unregisterReadHandleExitClose: (() => void) | null = null;

type AuthProfileReadPoolCloseScope =
  | { kind: "database"; databasePath: string }
  | { kind: "root"; rootPath: string };

export function closeAuthProfileReadDatabase(databasePath: string): void {
  const pathname = path.resolve(databasePath);
  const entry = authProfileReadDatabases.get(pathname);
  if (!entry) {
    return;
  }
  clearNodeSqliteKyselyCacheForDatabase(entry.db);
  if (entry.db.isOpen) {
    entry.db.close();
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  // Failed closes remain owned so scoped disposal can retain the root and retry.
  authProfileReadDatabases.delete(pathname);
  if (authProfileReadDatabases.size === 0) {
    unregisterReadHandleExitClose?.();
    unregisterReadHandleExitClose = null;
  }
}

/** Internal lifecycle close for scoped or all process-local pooled auth-profile readers. */
export function closeAuthProfileReadPool(scope?: AuthProfileReadPoolCloseScope): void {
  if (scope?.kind === "database") {
    closeAuthProfileReadDatabase(scope.databasePath);
    return;
  }
  if (scope?.kind === "root") {
    for (const pathname of authProfileReadDatabases.keys()) {
      if (isPathInside(scope.rootPath, pathname)) {
        closeAuthProfileReadDatabase(pathname);
      }
    }
    return;
  }
  for (const pathname of authProfileReadDatabases.keys()) {
    closeAuthProfileReadDatabase(pathname);
  }
}

function armReadHandleIdleClose(pathname: string, entry: AuthProfileReadHandle): void {
  if (entry.idleTimer) {
    entry.idleTimer.refresh();
    return;
  }
  const timer = runInSqliteMaintenanceContext(() =>
    setTimeout(() => {
      if (authProfileReadDatabases.get(pathname) !== entry || entry.idleTimer !== timer) {
        return;
      }
      try {
        closeAuthProfileReadDatabase(pathname);
      } catch (error) {
        // Retain native custody and retry at the same bounded idle interval.
        timer.refresh();
        process.emitWarning(`Failed to close idle auth profile reader: ${String(error)}`, {
          type: "AuthProfileReadPoolError",
        });
      }
    }, AUTH_PROFILE_READ_IDLE_MS),
  );
  timer.unref();
  entry.idleTimer = timer;
}

export function isMissingDatabasePath(pathname: string): boolean {
  try {
    fs.statSync(pathname);
    return false;
  } catch (error) {
    return hasErrnoCode(error, "ENOENT");
  }
}

export function acquireAuthProfileReadDatabase(
  pathname: string,
): { status: "missing" } | { status: "unreadable" } | { status: "readable"; db: DatabaseSync } {
  const resolvedPath = path.resolve(pathname);
  const cached = authProfileReadDatabases.get(resolvedPath);
  if (cached?.ready && cached.db.isOpen) {
    authProfileReadDatabases.delete(resolvedPath);
    authProfileReadDatabases.set(resolvedPath, cached);
    armReadHandleIdleClose(resolvedPath, cached);
    return { status: "readable", db: cached.db };
  }
  if (cached) {
    closeAuthProfileReadDatabase(resolvedPath);
  }
  // A failed candidate close must be retried before another handle is opened.
  // This bounds custody to the pool plus one unadmitted candidate.
  for (const [pendingPath, entry] of authProfileReadDatabases) {
    if (!entry.ready) {
      closeAuthProfileReadDatabase(pendingPath);
    }
  }
  let db: DatabaseSync;
  try {
    db = openNodeSqliteDatabase(resolvedPath, { readOnly: true });
  } catch {
    return isMissingDatabasePath(resolvedPath) ? { status: "missing" } : { status: "unreadable" };
  }
  const candidate: AuthProfileReadHandle = { db, ready: false };
  authProfileReadDatabases.set(resolvedPath, candidate);
  unregisterReadHandleExitClose ??= registerSqliteCacheExitClose(closeAuthProfileReadPool);
  armReadHandleIdleClose(resolvedPath, candidate);
  let readable = false;
  try {
    enableNodeSqliteKyselyStatementCache(db);
    // The pooled reader bypasses canonical agent DB bootstrap, but it shares
    // the same busy policy and validates the process-stable schema on open.
    setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    readable = readSqliteUserVersion(db) <= OPENCLAW_AGENT_SCHEMA_VERSION;
  } catch {
    // Invalid readers are disposed below, where native close failures propagate.
  }
  if (!readable) {
    closeAuthProfileReadDatabase(resolvedPath);
    return { status: "unreadable" };
  }
  try {
    while (authProfileReadDatabases.size > AUTH_PROFILE_READ_HANDLE_CAP) {
      const oldestPath = authProfileReadDatabases.keys().next().value;
      if (oldestPath === undefined) {
        break;
      }
      closeAuthProfileReadDatabase(oldestPath);
    }
  } catch (error) {
    try {
      closeAuthProfileReadDatabase(resolvedPath);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Unable to close auth profile readers", {
        cause: closeError,
      });
    }
    throw error;
  }
  candidate.ready = true;
  return { status: "readable", db };
}
