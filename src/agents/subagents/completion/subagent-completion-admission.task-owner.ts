// Attributes run-id task ownership when subagent completion settlement refuses.
import type { OpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { listTaskRecordsByRunIdForViewInDatabase } from "../../../tasks/task-registry.store.kernel.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";

/**
 * Every task row holding one run id, in lookup preference order. Run ids are not unique
 * across runtimes and the shared run-id view returns a single preferred row, so a
 * refusal that reports only "owner changed" cannot tell an operator whether the id is
 * unheld or held by another runtime. Reading every row supplies that. It decides
 * nothing: settlement still refuses while any row holds the id, so a completion whose
 * execution owner lives in another runtime keeps its result and its durable wake.
 */
export function readRunIdTaskRows(
  database: OpenClawStateDatabase,
  runId: string,
): readonly TaskRecord[] {
  return listTaskRecordsByRunIdForViewInDatabase(database.db, runId);
}

/**
 * Names which runtimes hold this run id, for the settlement refusal journal. This
 * describes the ledger, not the conjunct that refused: a refusal can also come from a
 * superseded in-memory owner or a newer sibling while no row holds the id at all. It is
 * phrased as an observation so it never reads as the cause, and it lists every holding
 * runtime so a collision between more than two rows is not reported as one.
 */
export function describeRunIdTaskRows(rows: readonly TaskRecord[]): string {
  if (rows.length === 0) {
    return "run id held by no task row";
  }
  const runtimes = [...new Set(rows.map((task) => task.runtime))].toSorted();
  return `run id held by ${runtimes.join(", ")}`;
}
