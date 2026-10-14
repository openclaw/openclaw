import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isPostgresSqlConnection, sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";

type PendingPublication = {
  revision: number;
  settled: Promise<void>;
  settle: () => void;
};

// Retain only live publications, never credential bodies or dormant database revisions.
const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.authProfilePendingCommits"),
  () => new Map<string, Set<PendingPublication>>(),
);

export function watchAuthProfileNativeCommits(databasePath: string) {
  const key = resolveIdentityPathViaExistingAncestorSync(databasePath);
  const watches = pending.get(key) ?? new Set<PendingPublication>();
  const settled = createDeferredCore();
  const watch = { revision: 0, settled: settled.promise, settle: () => settled.resolve() };
  watches.add(watch);
  pending.set(key, watches);
  return {
    capture() {
      const revision = watch.revision;
      return () => watch.revision === revision;
    },
    dispose() {
      watches.delete(watch);
      watch.settle();
      if (watches.size === 0) {
        pending.delete(key);
      }
    },
  };
}

/** Observation waits for current native writers and their host publications to finish. */
export async function waitForAuthProfileNativePublications(
  databasePaths: Iterable<string>,
): Promise<void> {
  const paths = [...new Set(databasePaths)];
  for (;;) {
    const publications = paths.flatMap((pathname) => Array.from(pending.get(pathname) ?? []));
    if (!publications.length) {
      return;
    }
    await Promise.all(publications.map((publication) => publication.settled));
  }
}

/** Native COMMIT can overtake a worker result before its host publication runs. */
export function recordAuthProfileNativeCommit(database: EngineConnection): void {
  if (pending.size === 0) {
    return;
  }
  const location = isPostgresSqlConnection(database)
    ? readTrackedStateDatabaseIdentity(sqlPublicationAnchor(database))?.canonicalPath
    : database.location();
  if (!location) {
    return;
  }
  const key = resolveIdentityPathViaExistingAncestorSync(location);
  const commit = () => {
    for (const watch of pending.get(key) ?? []) {
      watch.revision += 1;
    }
  };
  if (!database.isTransaction) {
    commit();
  } else if (!stageSqliteTransactionState(database, { stage() {}, commit, rollback() {} })) {
    throw new Error("Auth profile write requires a managed commit owner");
  }
}
