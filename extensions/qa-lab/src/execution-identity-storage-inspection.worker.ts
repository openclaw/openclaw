import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  tableExists,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { z } from "zod";
import type { QaExecutionIdentityStorageOperations } from "./execution-identity-storage-inspection.js";

type QaExecutionIdentityDatabase = {
  subagent_runs: { payload_json: string; requester_session_key: string; created_at: number };
  execution_identity_contexts: { context_id: string };
  execution_decision_facts: { run_id: string; action_family: string; reason_code: string };
};

const nativeRunSchema = z.object({
  runId: z.string().min(1),
  childSessionKey: z.string().min(1),
  requesterSessionKey: z.string().min(1),
  label: z.string().optional(),
  execution: z.object({
    status: z.string(),
    endedAt: z.number().optional(),
    outcome: z.object({ status: z.string() }).optional(),
  }),
  delivery: z.object({ status: z.string(), disposition: z.string().optional() }).optional(),
});

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<QaExecutionIdentityStorageOperations> {
  const database = openNodeSqliteDatabase(context.databasePath, { readOnly: true });
  return {
    execute(command) {
      const query = getNodeSqliteKysely<QaExecutionIdentityDatabase>(database);
      if (command.type === "subagentRuns") {
        if (!tableExists(database, "subagent_runs")) {
          return [];
        }
        let selection = query.selectFrom("subagent_runs").select(["payload_json", "created_at"]);
        if (command.input.requesterSessionKey) {
          selection = selection.where(
            "requester_session_key",
            "=",
            command.input.requesterSessionKey,
          );
        }
        return executeSqliteQuerySync(
          database,
          selection.orderBy("created_at", "desc").limit(1000),
        ).rows.map((row) =>
          Object.assign(nativeRunSchema.parse(JSON.parse(row.payload_json)), {
            createdAt: row.created_at,
          }),
        );
      }
      const decisionFilter = command.input;
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
