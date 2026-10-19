import type { Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../../infra/sqlite-number.js";
import { runSqliteImmediateTransactionSync } from "../../../infra/sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "../../../infra/sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "../../../infra/sqlite-worker-contract.js";
import { encodeSqliteWorkerDomainError } from "../../../infra/sqlite-worker-domain-error.js";
import type { DB } from "../../../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../../state/openclaw-state-db-contract.js";
import type { OpenClawStateWorkerErrorPayload } from "../../../state/openclaw-state-worker-error.js";

export type AcpParentStreamWorkerOperations = {
  record: {
    input: {
      sessionId: string;
      runId: string;
      events: Array<{ eventJson: string; createdAt: number }>;
    };
    output: Result<void, OpenClawStateWorkerErrorPayload>;
  };
};

export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: EngineConnection;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<AcpParentStreamWorkerOperations> {
  const database = context.database;
  const db = getNodeSqliteKysely<Pick<DB, "acp_parent_stream_events">>(database);
  return bindSqliteWorkerDatabase<AcpParentStreamWorkerOperations>(database, {
    execute({ input }) {
      try {
        runSqliteImmediateTransactionSync(
          database,
          () => {
            context.admit("transaction");
            const row = executeSqliteQueryTakeFirstSync(
              database,
              db
                .selectFrom("acp_parent_stream_events")
                .select((eb) => eb.fn.max<number | bigint>("seq").as("max_seq"))
                .where("session_id", "=", input.sessionId)
                .where("run_id", "=", input.runId),
            );
            const firstSeq = row?.max_seq == null ? 0 : sqliteNumber(row.max_seq) + 1;
            executeSqliteQuerySync(
              database,
              db.insertInto("acp_parent_stream_events").values(
                input.events.map((entry, index) => ({
                  session_id: input.sessionId,
                  run_id: input.runId,
                  seq: firstSeq + index,
                  event_json: entry.eventJson,
                  created_at: entry.createdAt,
                })),
              ),
            );
          },
          {
            operationLabel: "acp.parent-stream.record",
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: context.databasePath,
            withCommit(commit) {
              context.admit("commit");
              commit();
            },
          },
        );
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: encodeSqliteWorkerDomainError(database, error) };
      }
    },
  });
}
