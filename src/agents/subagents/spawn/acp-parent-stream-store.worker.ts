import type { DatabaseSync } from "node:sqlite";
import type { Result } from "@openclaw/normalization-core/result";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../../infra/sqlite-number.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../../infra/sqlite-worker-contract.js";
import type { DB } from "../../../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../../state/openclaw-state-db-contract.js";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../../../state/openclaw-state-worker-error.js";

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
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<AcpParentStreamWorkerOperations> {
  const database = context.database;
  const db = getNodeSqliteKysely<Pick<DB, "acp_parent_stream_events">>(database);
  return {
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
        // Only confirmed rollback is retryable; uncertain settlement stays with the broker.
        assertTransactionUsable(database);
        if (!database.isOpen || database.isTransaction) {
          throw error;
        }
        const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
        if (!failure) {
          throw error;
        }
        return { ok: false, error: failure };
      }
    },
    assertSettled() {
      assertTransactionUsable(database);
      if (database.isTransaction) {
        throw new Error("ACP parent-stream transaction did not settle");
      }
    },
    close() {},
  };
}
