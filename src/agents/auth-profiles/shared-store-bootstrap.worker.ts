import fs from "node:fs";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "../../infra/node-sqlite.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { assertDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { writeConfigMachineStateInDatabase } from "../../state/config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "../../state/config-machine-state.js";
import { agentEngineInput, openAgentEngineStore } from "../../state/openclaw-agent-db-engine.js";
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
        expression
          .exists(
            expression
              .selectFrom("migration_sources")
              .select("source_key")
              .where("migration_kind", "=", SHARED_AUTH_STORE_MIGRATION_KIND)
              .where("source_path", "=", input.fallbackSourcePath ?? input.sourcePath)
              .where("removed_source", "=", 0),
          )
          .as("fallbackPendingCleanup"),
      ]),
    );
  }, options);
  const initialOwnership = parseSharedAuthStoreOwnership(
    initial?.ownership == null ? undefined : JSON.parse(initial.ownership),
  );
  if (
    initialOwnership.location === "state-db" ||
    initial?.pendingCleanup ||
    (input.fallbackSourcePath !== undefined && initial?.fallbackPendingCleanup)
  ) {
    return { ownership: initialOwnership, relocated: false };
  }
  const commit = (
    emptySource: boolean,
    handoffSourcePath = input.sourcePath,
  ): AuthProfileBootstrapResult => {
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
          !hasPendingSharedAuthCleanupInDatabase(db, handoffSourcePath);
        const result: AuthProfileBootstrapResult = {
          ownership: relocated ? { location: "state-db" } : ownership,
          relocated,
          sourcePath: handoffSourcePath,
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
  const legacySourcePresent = (sources: string[] | undefined) =>
    (sources ?? []).some((source) => fs.existsSync(source));
  if (
    !input.sourceIdentity ||
    legacySourcePresent(input.legacySourcePaths) ||
    legacySourcePresent(input.fallbackLegacySourcePaths)
  ) {
    return commit(false);
  }
  assertDatabasePathIdentity(input.sourcePath, input.sourceIdentity);
  if (!input.sourceIdentity.key.startsWith("file:")) {
    // A non-file source cannot be compared with main here; leave cutover to Doctor.
    return commit(input.fallbackSourcePath === undefined);
  }
  let inspected = false;
  let source: EngineConnection | undefined;
  let anchor: ReturnType<typeof openNodeSqliteDatabase> | undefined;
  try {
    anchor = openNodeSqliteDatabase(resolveExistingSqliteFileUri(input.sourcePath));
    source = anchor;
    if (agentEngineInput()) {
      source = openAgentEngineStore(
        anchor,
        undefined,
        input.sourcePath,
        true,
        (connection, error) => {
          source = connection;
          throw error;
        },
      );
    }
    // SQLite ignores the writer reservation on a read-only connection. mode=rw
    // keeps this lock-only handle from creating a missing source or changing its schema.
    const inspect = () => {
      assertDatabasePathIdentity(input.sourcePath, input.sourceIdentity!);
      const rows = readSharedAuthLegacyRowsFromDatabase(source!);
      inspected = true;
      if (rows.store || rows.state) {
        return commit(false);
      }
      // Main still backs inherited reads until ownership flips. Never flip while it
      // holds rows the owner's empty store would not carry across.
      if (input.fallbackSourcePath !== undefined) {
        if (
          !input.fallbackSourceIdentity ||
          !input.fallbackSourceIdentity.key.startsWith("file:")
        ) {
          return commit(false);
        }
        const fallbackPath = input.fallbackSourcePath;
        const fallbackIdentity = input.fallbackSourceIdentity;
        let fallbackAnchor: ReturnType<typeof openNodeSqliteDatabase> | undefined;
        try {
          // Main still backs inherited reads until ownership flips. Hold its existing-file
          // writer reservation through the shared commit so a foreign writer cannot make
          // the emptiness decision stale.
          fallbackAnchor = openNodeSqliteDatabase(resolveExistingSqliteFileUri(fallbackPath));
          return runSqliteImmediateTransactionSync(
            fallbackAnchor,
            () => {
              assertDatabasePathIdentity(fallbackPath, fallbackIdentity);
              const fallbackRows = readSharedAuthLegacyRowsFromDatabase(fallbackAnchor!);
              if (fallbackRows.store || fallbackRows.state) {
                return commit(false);
              }
              return commit(true, fallbackPath);
            },
            { operationLabel: "auth-profiles.bootstrap-fallback-source" },
          );
        } catch {
          // Leave unreadable fallback state to Doctor rather than flipping ownership past it.
          return commit(false);
        } finally {
          fallbackAnchor?.close();
        }
      }
      return commit(true);
    };
    if (isPostgresSqlConnection(source)) {
      const postgres = source;
      // Read after the source writer's lock settles, without a second mutation receipt.
      return postgres.runTransaction(
        () => {
          // sqlite-allow-raw -- The source snapshot must include a writer that commits while this lock waits.
          postgres.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
          // sqlite-allow-raw -- Hold the source writer's existing advisory lock during inspection.
          postgres.prepare("SELECT pg_advisory_xact_lock(?)").get(postgres.advisoryLockKey);
          return inspect();
        },
        undefined,
        true,
      );
    }
    return runSqliteImmediateTransactionSync(source, inspect, {
      operationLabel: "auth-profiles.bootstrap-source",
    });
  } catch (error) {
    if (inspected) {
      throw error;
    }
    // Unreadable or partially migrated legacy state remains Doctor-owned.
    return commit(false);
  } finally {
    try {
      source?.close();
    } finally {
      if (source !== anchor && anchor?.isOpen) {
        anchor.close();
      }
    }
  }
}
