import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  ensureOpenClawAgentStandingIntentsSchema,
  runSqliteImmediateTransactionSync,
  withSqlitePostCommitPublications,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  cancelStandingIntentInDatabase,
  createStandingIntentInDatabase,
  listStandingIntentsInDatabase,
  maintainStandingIntentLifecycle,
  matchStandingIntentsInDatabase,
} from "./standing-intents-kernel.js";
import type { StandingIntentWorkerOperations } from "./standing-intents-model.js";

/** The canonical agent executor retains and closes this connection. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: { database: DatabaseSync; admit(stage: "transaction" | "commit"): void },
): SqliteWorkerBackend<StandingIntentWorkerOperations> {
  const db = context.database;
  const transact = <T>(run: () => T): T =>
    runSqliteImmediateTransactionSync(
      db,
      () => {
        context.admit("transaction");
        return run();
      },
      {
        withCommit(commit) {
          context.admit("commit");
          commit();
        },
      },
    );
  let schemaPrepared = false;
  // First-use installation commits independently and consumes this request's grant pair.
  withSqlitePostCommitPublications(db, () =>
    ensureOpenClawAgentStandingIntentsSchema(db, (run) => {
      const result = transact(run);
      schemaPrepared = true;
      return result;
    }),
  );
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Standing-intent worker binding is closed");
      }
      if (schemaPrepared) {
        return { kind: "schema-prepared" };
      }
      return transact<
        StandingIntentWorkerOperations[keyof StandingIntentWorkerOperations]["output"]
      >(() => {
        switch (command.type) {
          case "create":
            return { kind: "result", value: createStandingIntentInDatabase(db, command.input) };
          case "list":
            return { kind: "result", value: listStandingIntentsInDatabase(db, command.input) };
          case "sweep":
            return {
              kind: "result",
              value: maintainStandingIntentLifecycle(db, command.input.nowMs ?? Date.now()),
            };
          case "cancel":
            return { kind: "result", value: cancelStandingIntentInDatabase(db, command.input) };
          case "match":
            return { kind: "result", value: matchStandingIntentsInDatabase(db, command.input) };
        }
        throw new Error("Unknown standing-intent command");
      });
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Standing-intent operation left an unsettled native connection");
      }
    },
    close() {
      closed = true;
    },
  };
}
