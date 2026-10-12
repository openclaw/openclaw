import { isSubagentRunStillRunning } from "../announce/subagent-announce-output.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveSubagentRunDeadlineMs } from "./subagent-run-timeout.js";

/**
 * A run that already published its explicit-deadline timeout, and whose
 * announcement or cleanup already drained, fences later duplicate completions.
 */
export function shouldPreservePublishedExplicitRunTimeout(entry: SubagentRunRecord): boolean {
  if (
    entry.execution.outcome?.status !== "timeout" ||
    typeof entry.execution.endedAt !== "number" ||
    // A wait-expiry publication describes the waiter, not the run. Fencing the
    // run behind it would discard the child's own terminal callback and leave
    // the parent's last word "timed out" for a child that went on to finish.
    isSubagentRunStillRunning(entry.execution.outcome)
  ) {
    return false;
  }
  const deadlineMs = resolveSubagentRunDeadlineMs(entry);
  if (deadlineMs === undefined || entry.execution.endedAt < deadlineMs) {
    return false;
  }
  return (
    entry.cleanupHandled === true ||
    typeof entry.cleanupCompletedAt === "number" ||
    typeof entry.endedHookEmittedAt === "number" ||
    entry.delivery?.status === "delivered" ||
    typeof entry.delivery?.announcedAt === "number"
  );
}

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
