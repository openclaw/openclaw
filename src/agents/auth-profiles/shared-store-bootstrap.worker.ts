import fs from "node:fs";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { assertDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { writeConfigMachineStateInDatabase } from "../../state/config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "../../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import { parseSharedAuthStoreOwnership } from "./path-resolve.js";
import {
  hasPendingSharedAuthCleanupInDatabase,
  readSharedAuthLegacyRowsFromDatabase,
  SHARED_AUTH_STORE_MIGRATION_KIND,
} from "./shared-store-bootstrap.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import type {
  AuthProfileBootstrapInput,
  AuthProfileBootstrapResult,
} from "./store.worker-contract.js";

/** Hold the legacy source before shared state, matching auth writers and Doctor's exclusion. */
export function bootstrapSharedAuthStoreInWorker(
  input: AuthProfileBootstrapInput,
  context: WorkerOperationContext,
): AuthProfileBootstrapResult {
  const options = context.stateOptions();
  const initial = withExistingOpenClawStateDatabaseReadOnly(({ db: database }) => {
    const db =
      getNodeSqliteKysely<
        Pick<OpenClawStateKyselyDatabase, "config_machine_state" | "migration_sources">
      >(database);
    return executeSqliteQueryTakeFirstSync(
      database,
      db.selectNoFrom((expression) => [
        expression
          .selectFrom("config_machine_state")
          .select("value_json")
          .where("state_key", "=", SHARED_AUTH_STORE_STATE_KEY)
          .as("ownership"),
        expression
          .exists(
            expression
              .selectFrom("migration_sources")
              .select("source_key")
              .where("migration_kind", "=", SHARED_AUTH_STORE_MIGRATION_KIND)
              .where("source_path", "=", input.sourcePath)
              .where("removed_source", "=", 0),
          )
          .as("pendingCleanup"),
      ]),
    );
  }, options);
  const initialOwnership = parseSharedAuthStoreOwnership(
    initial?.ownership == null ? undefined : JSON.parse(initial.ownership),
  );
  if (initialOwnership.location === "state-db" || initial?.pendingCleanup) {
    return { ownership: initialOwnership, relocated: false };
  }
  const commit = (emptySource: boolean): AuthProfileBootstrapResult => {
    if (!emptySource) {
      return { ownership: initialOwnership, relocated: false };
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const row = readConfigMachineStateRowInDatabase(db, SHARED_AUTH_STORE_STATE_KEY);
        const ownership = parseSharedAuthStoreOwnership(
          row ? JSON.parse(row.value_json) : undefined,
        );
        const relocated =
          ownership.location === "legacy-main" &&
          emptySource &&
          !hasPendingSharedAuthCleanupInDatabase(db, input.sourcePath);
        const result: AuthProfileBootstrapResult = {
          ownership: relocated ? { location: "state-db" } : ownership,
          relocated,
        };
        if (relocated) {
          writeConfigMachineStateInDatabase(db, SHARED_AUTH_STORE_STATE_KEY, result.ownership);
        }
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        deferSqliteWorkerCommitReceipt(db, result);
        return result;
      },
      options,
      { operationLabel: "auth-profiles.bootstrap" },
    );
  };
  if (!input.sourceIdentity || input.legacySourcePaths.some((source) => fs.existsSync(source))) {
    return commit(false);
  }
  assertDatabasePathIdentity(input.sourcePath, input.sourceIdentity);
  if (!input.sourceIdentity.key.startsWith("file:")) {
    return commit(true);
  }
  let inspected = false;
  let source: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    source = openNodeSqliteDatabase(resolveExistingSqliteFileUri(input.sourcePath));
    // SQLite ignores the writer reservation on a read-only connection. mode=rw
    // keeps this lock-only handle from creating a missing source or changing its schema.
    return runSqliteImmediateTransactionSync(
      source,
      () => {
        assertDatabasePathIdentity(input.sourcePath, input.sourceIdentity!);
        const rows = readSharedAuthLegacyRowsFromDatabase(source!);
        inspected = true;
        return commit(!rows.store && !rows.state);
      },
      { operationLabel: "auth-profiles.bootstrap-source" },
    );
  } catch (error) {
    if (inspected) {
      throw error;
    }
    // Unreadable or partially migrated legacy state remains Doctor-owned.
    return commit(false);
  } finally {
    source?.close();
  }
}
