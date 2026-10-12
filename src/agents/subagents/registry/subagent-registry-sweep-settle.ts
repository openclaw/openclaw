import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { resolveYieldedRunContinuation } from "./subagent-registry-run-pause.js";
import type { createSubagentSweepReadScope } from "./subagent-registry-sweep-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isYieldedSubagentRun } from "./subagent-run-liveness.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

type CompleteRun = ReturnType<
  typeof createSubagentRegistryCompletionRuntime
>["completeSubagentRunWithRecovery"];
type SweepReadScope = ReturnType<typeof createSubagentSweepReadScope>;

/** Settles an active-looking run whose execution context is gone, from its session or as lost. */
export async function settleStaleActiveSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  readScope: SweepReadScope;
  complete: CompleteRun;
}): Promise<void> {
  const { runId, entry, now, readScope, complete } = params;
  const assertActiveReadCurrent = () => {
    readScope.assertRunCurrent(entry);
    if (
      typeof entry.execution.endedAt === "number" ||
      entry.execution.status === "queued" ||
      entry.killIntent ||
      entry.killReconciliation ||
      getAgentRunContext(runId)
    ) {
      throw readScope.retiredRead;
    }
  };
  let observation;
  try {
    assertActiveReadCurrent();
    const classification = resolveSubagentRunOrphanReason({ entry });
    observation =
      typeof classification === "object" && classification !== null
        ? await classification.read(assertActiveReadCurrent)
        : {
            orphanReason: classification,
            sessionEntry: await loadSubagentSessionEntry({
              childSessionKey: entry.childSessionKey,
              childAgentId: entry.childAgentId,
              assertCurrent: assertActiveReadCurrent,
            }),
          };
    assertActiveReadCurrent();
  } catch (error) {
    if (error === readScope.retiredRead) {
      return;
    }
    throw error;
  }
  const { orphanReason, sessionEntry } = observation;
  const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
    notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
  });
  await complete(
    {
      runId,
      expectedEntry: entry,
      recoveryCurrent: readScope.completionCurrent,
      ...(completion ?? {
        endedAt: now,
        outcome: {
          status: "error" as const,
          error: orphanReason
            ? `subagent run orphaned: ${orphanReason}`
            : "subagent run lost active execution context",
        },
        reason: SUBAGENT_ENDED_REASON_ERROR,
      }),
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    },
    completion ? "sweeper-session-completion" : "sweeper-lost-context",
  );
}

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
  await complete(
    {
      runId,
      expectedEntry: entry,
      recoveryCurrent: readScope.completionCurrent,
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
