import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  tableExists,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { QaExecutionIdentityStorageOperations } from "./execution-identity-storage-inspection.js";

type QaExecutionIdentityDatabase = {
  execution_identity_contexts: { context_id: string };
  execution_decision_facts: { run_id: string; action_family: string; reason_code: string };
};

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<QaExecutionIdentityStorageOperations> {
  const database = openNodeSqliteDatabase(context.databasePath, { readOnly: true });
  return {
    execute({ input: decisionFilter }) {
      const query = getNodeSqliteKysely<QaExecutionIdentityDatabase>(database);
      const contextCount = tableExists(database, "execution_identity_contexts")
        ? (executeSqliteQueryTakeFirstSync(
            database,
            query
              .selectFrom("execution_identity_contexts")
              .select((eb) => eb.fn.countAll<number>().as("count")),
          )?.count ?? 0)
        : 0;
      let decisionCount = 0;
      if (tableExists(database, "execution_decision_facts")) {
        let selection = query
          .selectFrom("execution_decision_facts")
          .select((eb) => eb.fn.countAll<number>().as("count"));
        if (decisionFilter) {
          selection = selection
            .where("run_id", "=", decisionFilter.runId)
            .where("action_family", "=", decisionFilter.actionFamily)
            .where("reason_code", "=", decisionFilter.reasonCode);
        }
        decisionCount = executeSqliteQueryTakeFirstSync(database, selection)?.count ?? 0;
      }
      return { contextCount, decisionCount };
    },
    close() {
      database.close();
    },
  };
}
