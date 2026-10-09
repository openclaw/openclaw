import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import {
  recordInlineAuthFailureInDatabase,
  type InlineAuthFailureOperations,
} from "./inline-usage-kernel.js";
import { inspectAuthProfileJsonCell } from "./sqlite-json.js";
import {
  authProfilePeerGenerationMayMatch,
  updateAuthProfileStoreInDatabase,
} from "./store-update-kernel.js";
import { recordAuthProfileUsageInDatabase } from "./usage-kernel.js";

/** The canonical agent executor lends its connection and transaction/commit admission. */
export function bindSqliteWorkerBackend(
  _input: unknown,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<InlineAuthFailureOperations> {
  return {
    execute(command) {
      if (command.type === "authProfiles.update") {
        if (!authProfilePeerGenerationMayMatch(context.database, command.input)) {
          return false;
        }
        runSqliteWorkerTransactionSync(context, () =>
          updateAuthProfileStoreInDatabase(context.database, "agent", command.input),
        );
        return true;
      }
      if (command.type === "authProfiles.inlineSnapshot") {
        return runSqliteDeferredTransactionSync(context.database, () => ({
          store: inspectAuthProfileJsonCell(context.database, "store", "agent"),
          state: inspectAuthProfileJsonCell(context.database, "state", "agent"),
          cacheable: false,
        }));
      }
      let result:
        | InlineAuthFailureOperations["authProfiles.inlineFailure" | "authProfiles.usage"]["output"]
        | undefined;
      let committed = false;
      try {
        runSqliteWorkerTransactionSync(
          context,
          () => {
            if (command.type === "authProfiles.usage") {
              const receipt = recordAuthProfileUsageInDatabase(
                context.database,
                context.databasePath,
                "agent",
                command.input,
              );
              result = { ok: true, receipt };
            } else {
              const receipt = recordInlineAuthFailureInDatabase(
                context.database,
                context.databasePath,
                command.input,
              );
              result = { ok: true, receipt };
            }
          },
          {
            withCommit(commit) {
              commit();
              committed = true;
            },
          },
        );
      } catch (error) {
        if (!committed || !result) {
          // A confirmed rollback is a domain refusal, not an unsettled executor.
          assertTransactionUsable(context.database);
          if (!context.database.isOpen || context.database.isTransaction) {
            throw error;
          }
          const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
          if (!failure) {
            throw error;
          }
          return { ok: false, error: failure };
        }
        reportCommittedInlineAuthFailure(
          "Auth usage committed before transaction cleanup failed",
          error,
        );
      }
      if (!result) {
        throw new Error("Auth usage transaction produced no durable result");
      }
      return result;
    },
    assertSettled() {
      assertTransactionUsable(context.database);
      if (!context.database.isOpen || context.database.isTransaction) {
        throw new Error("Auth usage left an unsettled agent transaction");
      }
    },
    close() {},
  };
}
