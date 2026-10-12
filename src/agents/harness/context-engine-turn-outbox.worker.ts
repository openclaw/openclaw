import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import type { ContextEngineTurnOutboxWorkerOperations } from "./context-engine-turn-outbox.js";
import { executeContextEngineTurnOutboxCommand } from "./context-engine-turn-outbox.kernel.worker.js";

/** Borrows the canonical agent connection for one admitted outbox operation. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<ContextEngineTurnOutboxWorkerOperations> {
  const db = context.database;
  return {
    execute(command) {
      return runSqliteWorkerTransactionSync(
        context,
        () => executeContextEngineTurnOutboxCommand(db, command),
        {
          operationLabel: `context-engine.turn-outbox.${command.type}`,
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: context.databasePath,
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Context-engine turn outbox transaction did not settle");
      }
    },
    close() {},
  };
}
