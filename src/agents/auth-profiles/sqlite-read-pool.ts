import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  isDeletedAgentDatabasePath,
  matchesAgentDatabaseReadCandidatePath,
  registerAgentDatabaseReaderCloser,
} from "../../infra/agent-database-readers.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { isPathInside } from "../../infra/path-guards.js";
import { setSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { runWithSqliteCleanup } from "../../infra/sqlite-lifecycle-errors.js";
import {
  retainSnapshotTempDirectory,
  SqliteSnapshotCleanupError,
} from "../../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSync } from "../../infra/sqlite-snapshot-source.js";
import { readSqliteUserVersion } from "../../infra/sqlite-user-version.js";
import {
  registerSqliteCacheExitClose,
  runInSqliteMaintenanceContext,
} from "../../infra/sqlite-wal.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
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
  for (const pathname of authProfileReadDatabases.keys()) {
    if (scope?.kind !== "root" || isPathInside(scope.rootPath, pathname)) {
      closeAuthProfileReadDatabase(pathname);
    }
  }
}

registerAgentDatabaseReaderCloser((candidates, retainedPaths) => {
  for (const pathname of authProfileReadDatabases.keys()) {
    if (
      !retainedPaths?.has(pathname) &&
      candidates.some((candidate) => matchesAgentDatabaseReadCandidatePath(candidate, pathname))
    ) {
      closeAuthProfileReadDatabase(pathname);
    }
  }
});

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

/** Inspection owns its private reader through native close and snapshot disposal. */
export function withAuthProfileReadDatabase<T>(
  pathname: string,
  read: (acquired: ReturnType<typeof acquireAuthProfileReadDatabase>, inspectedPath: string) => T,
): T {
  if (!isArtifactPreservingStateRead("agent")) {
    return read(acquireAuthProfileReadDatabase(pathname), pathname);
  }
  const sourcePath = path.resolve(pathname);
  if (isDeletedAgentDatabasePath(sourcePath) || isMissingDatabasePath(sourcePath)) {
    return read({ status: "missing" }, sourcePath);
  }
  let snapshot: ReturnType<typeof prepareSqliteReadOnlyLocationSync>;
  try {
    snapshot = prepareSqliteReadOnlyLocationSync(sourcePath);
  } catch (error) {
    if (error instanceof SqliteSnapshotCleanupError) {
      throw error;
    }
    return read(
      { status: isMissingDatabasePath(sourcePath) ? "missing" : "unreadable" },
      sourcePath,
    );
  }
  const release = retainSnapshotTempDirectory(
    snapshot.cleanupRoot ?? path.dirname(snapshot.location),
  );
  return runWithSqliteCleanup(
    {
      release() {
        closeAuthProfileReadDatabase(snapshot.location);
        release();
        if (!snapshot.cleanup()) {
          throw new SqliteSnapshotCleanupError("Auth profile inspection snapshot cleanup failed.");
        }
      },
    },
    "Auth profile inspection",
    () => read(acquireAuthProfileReadDatabase(snapshot.location, true), snapshot.location),
  );
}

export function acquireAuthProfileReadDatabase(
  pathname: string,
  inspectionSnapshot = false,
): { status: "missing" } | { status: "unreadable" } | { status: "readable"; db: DatabaseSync } {
  const resolvedPath = path.resolve(pathname);
  if (isDeletedAgentDatabasePath(resolvedPath)) {
    return { status: "missing" };
  }
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
  // Live acquisition settles failed candidates; private inspection must not close source handles.
  if (!inspectionSnapshot) {
    for (const [pendingPath, entry] of authProfileReadDatabases) {
      if (!entry.ready) {
        closeAuthProfileReadDatabase(pendingPath);
      }
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
    if (!inspectionSnapshot) {
      while (authProfileReadDatabases.size > AUTH_PROFILE_READ_HANDLE_CAP) {
        const oldestPath = authProfileReadDatabases.keys().next().value;
        if (oldestPath === undefined) {
          break;
        }
        closeAuthProfileReadDatabase(oldestPath);
      }
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
