import { isSubagentRunStillRunning } from "../announce/subagent-announce-output.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";

/**
 * A wait-expiry publication described the waiter, not the run, so the announce
 * it already delivered is provisional. The run's own terminal callback must be
 * able to release that delivery and its cleanup bookkeeping, or the parent's
 * last word stays "still running" for a child that has finished.
 *
 * Guarded on the incoming disposition as well, so a second wait expiry on the
 * same live child cannot re-announce.
 */
export function supersedesProvisionalWaitExpiry(
  publishedOutcome: SubagentRunOutcome | undefined,
  completionOutcome: SubagentRunOutcome,
): boolean {
  return (
    isSubagentRunStillRunning(publishedOutcome) && !isSubagentRunStillRunning(completionOutcome)
  );
}

/**
 * Stamps the killed disposition for every cancellation producer, not just the
 * `entry.killIntent` path. The lifecycle cancellation listener, the sweeper's
 * cancellation grace, and persisted killed-session reconciliation all supply
 * the killed reason with no disposition, and `resolveSubagentRunDisposition`
 * reads that absence as `exited` — so announcement, which does not wait for
 * completion, published `exited` for a child that was killed.
 *
 * A cancellation completion is terminal by construction, so the reason is the
 * authority here: an absent disposition is not evidence of a clean exit, and a
 * `still-running` disposition drained from an earlier provisional wait-expiry
 * publication describes the waiter, not this run.
 */
export function withCancellationDisposition(outcome: SubagentRunOutcome): SubagentRunOutcome {
  return outcome.disposition === "killed" ? outcome : { ...outcome, disposition: "killed" };
}
