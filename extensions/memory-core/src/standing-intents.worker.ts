import type { DatabaseSync } from "node:sqlite";
import { ensureOpenClawAgentStandingIntentsSchema } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  assertTransactionUsable,
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
import type { StandingIntentOperations } from "./standing-intents-model.js";

/** The canonical agent executor retains and closes this connection. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: { database: DatabaseSync; admit(stage: "transaction" | "commit"): void },
): SqliteWorkerBackend<StandingIntentOperations> {
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
  // Preserve schema completion independently of the following business transaction.
  withSqlitePostCommitPublications(db, () =>
    transact(() => ensureOpenClawAgentStandingIntentsSchema(db)),
  );
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Standing-intent worker binding is closed");
      }
      return transact(() => {
        switch (command.type) {
          case "create":
            return createStandingIntentInDatabase(db, command.input);
          case "list":
            return listStandingIntentsInDatabase(db, command.input);
          case "sweep":
            return maintainStandingIntentLifecycle(db, command.input.nowMs ?? Date.now());
          case "cancel":
            return cancelStandingIntentInDatabase(db, command.input);
          case "match":
            return matchStandingIntentsInDatabase(db, command.input);
        }
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
