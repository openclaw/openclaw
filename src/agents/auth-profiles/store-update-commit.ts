import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { isPostgresSqlConnection, sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";
import type { AuthProfileStoreOwner } from "./types.js";

type PendingPublication = {
  revision: number;
  key?: string;
  preparing?: Set<string>;
};

// Retain only live publications, never credential bodies or dormant database revisions.
const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.authProfilePendingCommits"),
  () => new Set<PendingPublication>(),
);

export function watchAuthProfileNativeCommits(
  databasePath: string,
  identity:
    | AuthProfileStoreOwner["databaseIdentity"]
    | Promise<AuthProfileStoreOwner["databaseIdentity"]>,
) {
  const watch: PendingPublication = { revision: 0 };
  const qualify = (prepared: AuthProfileStoreOwner["databaseIdentity"]) => {
    watch.key = prepared
      ? "kind" in prepared
        ? prepared.nativeLocation
        : prepared.canonicalPath
      : databasePath;
    if (watch.preparing?.has(watch.key)) {
      watch.revision += 1;
    }
    watch.preparing = undefined;
  };
  let ready: Promise<void> | undefined;
  if (identity instanceof Promise) {
    // Keep actual commit receipts until the locator is qualified; unrelated writes do not fence it.
    watch.preparing = new Set();
    ready = identity.then(qualify).finally(() => {
      watch.preparing = undefined;
    });
  } else {
    qualify(identity);
  }
  pending.add(watch);
  return {
    ready,
    capture() {
      const revision = watch.revision;
      return () => watch.revision === revision;
    },
    dispose() {
      watch.preparing = undefined;
      pending.delete(watch);
    },
  };
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
  const key =
    readTrackedStateDatabaseIdentity(database)?.canonicalPath ??
    findOpenClawAgentDatabaseIdentity({ db: database })?.canonicalPath ??
    resolveIdentityPathViaExistingAncestorSync(location);
  const commit = () => {
    for (const watch of pending) {
      if (watch.key === key) {
        watch.revision += 1;
      } else {
        watch.preparing?.add(key);
      }
    }
  };
  if (!database.isTransaction) {
    commit();
  } else if (!stageSqliteTransactionState(database, { stage() {}, commit, rollback() {} })) {
    throw new Error("Auth profile write requires a managed commit owner");
  }
}
