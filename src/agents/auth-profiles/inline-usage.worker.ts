import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import {
  recordInlineAuthFailureInDatabase,
  type InlineAuthFailureOperations,
  type InlineAuthFailureReceipt,
} from "./inline-usage-kernel.js";
import { inspectAuthProfileJsonCell } from "./sqlite-json.js";

/** The canonical agent executor lends its connection and transaction/commit admission. */
export function bindSqliteWorkerBackend(
  _input: unknown,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<InlineAuthFailureOperations> {
  return {
    execute(command) {
      if (command.type === "authProfiles.inlineSnapshot") {
        return runSqliteDeferredTransactionSync(context.database, () => ({
          store: inspectAuthProfileJsonCell(context.database, "store", "agent"),
          state: inspectAuthProfileJsonCell(context.database, "state", "agent"),
          cacheable: false,
        }));
      }
      let receipt: InlineAuthFailureReceipt | undefined;
      let committed = false;
      try {
        runSqliteImmediateTransactionSync(
          context.database,
          () => {
            context.admit("transaction");
            receipt = recordInlineAuthFailureInDatabase(
              context.database,
              context.databasePath,
              command.input,
            );
          },
          {
            withCommit(commit) {
              context.admit("commit");
              commit();
              committed = true;
            },
          },
        );
      } catch (error) {
        if (!committed || !receipt) {
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
      if (!receipt) {
        throw new Error("Auth usage transaction produced no durable result");
      }
      return { ok: true, receipt };
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
