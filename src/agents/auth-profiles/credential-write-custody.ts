import { isMainThread } from "node:worker_threads";
import {
  acquireStateDatabaseSchemaLease,
  captureGatewayStateOwner,
  getStateDatabaseSchemaLease,
  type StateDatabaseSchemaLease,
} from "../../infra/gateway-state-owner.js";
import { sqlPublicationAnchor, type EngineConnection } from "../../infra/sql-connection.js";
import { getSqliteDatabaseAdmissionIdentityForPath } from "../../infra/sqlite-database-admission.js";
import { runWithSqliteCleanup } from "../../infra/sqlite-lifecycle-errors.js";
import {
  deferSqlitePostCommitPublication,
  hasSqlitePostCommitScope,
  stageSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import { currentSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { getSqliteWorkerStateIntegrityAdmission } from "../../infra/sqlite-worker-state-context.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-maintenance-context.js";
import { getWorkerAuthProfileWrites } from "./runtime-scope.js";

const retainedTransactions = resolveGlobalSingleton(
  Symbol.for("openclaw.authProfileCredentialWriteCustody"),
  () => new WeakMap<EngineConnection, { lease: StateDatabaseSchemaLease; unknown: boolean }>(),
);

/** Reuse native custody; standalone SDK callers take the existing exclusive offline lease. */
export function withAuthProfileCredentialOwner<T>(
  databasePath: string,
  operation: (retainTransaction?: (database: EngineConnection) => void) => T,
  database?: EngineConnection,
): T {
  const retained = database && retainedTransactions.get(sqlPublicationAnchor(database));
  if (retained) {
    if (retained.unknown) {
      throw new Error("Auth profile credential write outcome is unknown; restart its owner");
    }
    return retained.lease.run(operation);
  }
  const admission = currentSqliteWorkerOperationAdmission.getStore();
  if (admission) {
    const owner = getSqliteWorkerStateIntegrityAdmission()?.identity;
    const target =
      databasePath === owner?.canonicalPath
        ? owner
        : getSqliteDatabaseAdmissionIdentityForPath(databasePath);
    if (
      !admission.active ||
      !owner ||
      target?.key !== owner.key ||
      target?.birthtime !== owner.birthtime
    ) {
      throw new Error("Auth profile credential writes require an admitted worker");
    }
    return operation();
  }
  const catalog = getWorkerAuthProfileWrites();
  if (catalog) {
    return catalog.runSync(databasePath, operation);
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (maintenance?.ownsSchemaMaintenance) {
    maintenance.assertDatabaseAccess(databasePath);
    return operation();
  }
  if (getStateDatabaseSchemaLease(databasePath) || captureGatewayStateOwner(databasePath)) {
    return operation();
  }
  if (!isMainThread) {
    throw new Error("Auth profile credential writes require an admitted worker");
  }
  const lease = acquireStateDatabaseSchemaLease(databasePath);
  let transactionOwnsLease = false;
  const retainTransaction = (db: EngineConnection) => {
    if (!hasSqlitePostCommitScope(sqlPublicationAnchor(db))) {
      return;
    }
    const owner = { lease, unknown: false };
    const release = () => {
      retainedTransactions.delete(sqlPublicationAnchor(db));
      lease.release();
    };
    // Stage first so rollback releases after credential facts; commit release is an observer.
    transactionOwnsLease = stageSqliteTransactionState(sqlPublicationAnchor(db), {
      stage: () => retainedTransactions.set(sqlPublicationAnchor(db), owner),
      commit() {},
      rollback: release,
      invalidate: () => {
        // Unknown native outcomes retain exclusive custody until owner restart.
        owner.unknown = true;
      },
    });
    deferSqlitePostCommitPublication(sqlPublicationAnchor(db), release);
  };
  return runWithSqliteCleanup(
    {
      release: () => {
        if (!transactionOwnsLease) {
          lease.release();
        }
      },
    },
    "auth profile credential custody",
    () => lease.run(() => operation(retainTransaction)),
  );
}

/** The native opener captures the shared root, including agents outside the state directory. */
export function withAuthProfileCredentialWriteCustody<T>(
  database: EngineConnection,
  operation: () => T,
): T {
  if (database.isTransaction && !hasSqlitePostCommitScope(sqlPublicationAnchor(database))) {
    throw new Error("Credential writes require their owning transaction publication scope");
  }
  const agent = findOpenClawAgentDatabaseIdentity({ db: sqlPublicationAnchor(database) });
  const databasePath =
    agent?.ownerDatabasePath ??
    readTrackedStateDatabaseIdentity(sqlPublicationAnchor(database))?.canonicalPath;
  if (!databasePath) {
    throw new Error("Auth profile credential database has no captured state owner");
  }
  return withAuthProfileCredentialOwner(
    databasePath,
    (retain) => {
      retain?.(database);
      return operation();
    },
    database,
  );
}
