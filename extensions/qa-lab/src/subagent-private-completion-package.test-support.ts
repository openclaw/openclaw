import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function readPrivateCompletionRows(
  databasePath: string,
  sql: string,
  ...args: SQLInputValue[]
) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

/** Inspect fixture persistence; visibility proof still uses sessions.list and chat.history. */
export function readPrivateCompletionNativeRuns(databasePath: string, sessionKey: string) {
  return readPrivateCompletionRows(
    databasePath,
    "SELECT payload_json FROM subagent_runs WHERE requester_session_key = ? ORDER BY run_id",
    sessionKey,
  ).map((row) => {
    const run: unknown = JSON.parse(String(row.payload_json));
    if (!isRecord(run) || !isRecord(run.execution)) {
      throw new Error("Expected a native subagent execution in package fixture state");
    }
    const execution = run.execution;
    return {
      runId: run.runId,
      childSessionKey: run.childSessionKey,
      title: run.label,
      status:
        execution.status === "terminal"
          ? isRecord(execution.outcome) && execution.outcome.status === "ok"
            ? "completed"
            : "failed"
          : execution.status,
      deliveryStatus: isRecord(run.delivery) ? run.delivery.status : undefined,
    };
  });
}
