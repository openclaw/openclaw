import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { resolveYieldedRunContinuation } from "./subagent-registry-run-pause.js";
import type { createSubagentSweepReadScope } from "./subagent-registry-sweep-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isYieldedSubagentRun } from "./subagent-run-liveness.js";

type CompleteRun = ReturnType<
  typeof createSubagentRegistryCompletionRuntime
>["completeSubagentRunWithRecovery"];
type SweepReadScope = ReturnType<typeof createSubagentSweepReadScope>;

/**
 * Settles a yielded run that no continuation can reach (see
 * `resolveYieldedRunContinuation`) through the completion owner. Returns whether it did.
 */
export async function settleUnreachableYieldedSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  readScope: Pick<SweepReadScope, "completionCurrent">;
  complete: CompleteRun;
}): Promise<boolean> {
  const { runId, entry, readScope, complete } = params;
  const continuation = isYieldedSubagentRun(entry)
    ? resolveYieldedRunContinuation(entry)
    : undefined;
  if (continuation?.state !== "unreachable") {
    return false;
  }
  // An outcome the yield already recorded is kept, as a collector that yields now ends with its
  // yielded turn as its result; only a run with no recorded outcome takes the diagnostic error.
  const outcome = entry.execution.outcome ?? {
    status: "error" as const,
    error: continuation.error,
  };
  await complete(
    {
      runId,
      expectedEntry: entry,
      recoveryCurrent: readScope.completionCurrent,
      // The run ended when it yielded; settling now must not rewrite that time.
      endedAt: entry.execution.endedAt,
      outcome,
      reason:
        outcome.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
      settleYielded: true,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    "sweeper-unreachable-yield",
  );
  return true;
}
