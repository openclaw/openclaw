import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryEntryOriginsSchema,
  recordMemoryEntryOriginsInDatabase,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
  withSqlitePostCommitPublications,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { deleteMemoryEntryOriginsInDatabase } from "./memory-entry-origins-delete.js";
import type { MemoryEntryOriginOperations } from "./memory-entry-origins-task.js";

/** The existing agent executor owns this connection and its native lifetime. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: { database: DatabaseSync; admit(stage: "transaction" | "commit"): void },
): SqliteWorkerBackend<MemoryEntryOriginOperations> {
  const db = context.database;
  const admission = {
    onBegin: () => context.admit("transaction"),
    withCommit: (commit: () => void) => {
      context.admit("commit");
      commit();
    },
  };
  const transact = <T>(run: () => T): T =>
    runSqliteImmediateTransactionSync(
      db,
      () => {
        admission.onBegin();
        return run();
      },
      { withCommit: admission.withCommit },
    );
  // A rejected origin batch must not undo the original additive schema preparation.
  withSqlitePostCommitPublications(db, () => transact(() => ensureMemoryEntryOriginsSchema(db)));
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Memory origin worker binding is closed");
      }
      if (command.type === "record") {
        return transact(() => recordMemoryEntryOriginsInDatabase(db, command.input));
      }
      return deleteMemoryEntryOriginsInDatabase(db, command.input, admission);
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (!db.isOpen || db.isTransaction) {
        throw new Error("Memory origin operation left an unsettled native connection");
      }
    },
    close() {
      closed = true;
    },
  };
}
