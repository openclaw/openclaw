/**
 * Reconcile stale active subagent runs that lost live execution context.
 *
 * When the sweeper cannot resolve terminal state from the session store, readable child
 * assistant output is treated as ground truth — the subagent completed successfully while the
 * parent still needs the result.  Without this reconciliation, the parent receives a plain
 * failure despite the child having delivered output, causing a lifecycle/result mismatch.
 */
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import { readSubagentOutput } from "./subagent-announce-output.js";

export const LOST_ACTIVE_EXECUTION_CONTEXT_ERROR = "subagent run lost active execution context";

/** Resolve terminal outcome for a stale active run with no live `agent.run` context. */
export async function resolveStaleActiveSubagentOutcome(params: {
  childSessionKey: string;
}): Promise<SubagentRunOutcome> {
  const output = await readSubagentOutput(params.childSessionKey);
  if (output?.trim()) {
    return { status: "ok" };
  }
  return {
    status: "error",
    error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
  };
}
