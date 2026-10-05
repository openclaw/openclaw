import { isYieldedSubagentRun } from "./subagent-execution-observation.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { resolveYieldedRunContinuation } from "./subagent-registry-run-pause.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

type CompleteRun = ReturnType<
  typeof createSubagentRegistryCompletionRuntime
>["completeSubagentRunWithRecovery"];

/** Settles an active-looking run whose execution context is gone, from its session or as lost. */
export async function settleStaleActiveSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  complete: CompleteRun;
}): Promise<void> {
  const { runId, entry, now, complete } = params;
  const orphanReason = resolveSubagentRunOrphanReason({ entry });
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: entry.childSessionKey,
  });
  const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
    notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
  });
  if (completion) {
    await complete(
      {
        runId,
        startedAt: completion.startedAt,
        endedAt: completion.endedAt,
        outcome: completion.outcome,
        reason: completion.reason,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      },
      "sweeper-session-completion",
    );
    return;
  }

  await complete(
    {
      runId,
      expectedEntry: entry,
      endedAt: now,
      outcome: {
        status: "error",
        error: orphanReason
          ? `subagent run orphaned: ${orphanReason}`
          : "subagent run lost active execution context",
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    "sweeper-lost-context",
  );
}

/**
 * Settles a yielded run that no continuation can reach (see
 * `resolveYieldedRunContinuation`) through the completion owner. Returns whether it did.
 */
export async function settleUnreachableYieldedSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  complete: CompleteRun;
}): Promise<boolean> {
  const { runId, entry, complete } = params;
  const continuation = isYieldedSubagentRun(entry)
    ? resolveYieldedRunContinuation(entry)
    : undefined;
  if (continuation?.state !== "unreachable") {
    return false;
  }
  await complete(
    {
      runId,
      expectedEntry: entry,
      // The run ended when it yielded; settling now must not rewrite that time.
      endedAt: entry.execution.endedAt,
      outcome: { status: "error", error: continuation.error },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      settleYielded: true,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    "sweeper-unreachable-yield",
  );
  return true;
}
