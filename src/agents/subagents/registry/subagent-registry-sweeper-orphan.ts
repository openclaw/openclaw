/**
 * Sweep handling for runs that are still marked active but have no execution
 * context left — the shape a subagent run is left in when the gateway dies
 * underneath it.
 *
 * Split out of the sweeper so the reap decision, which has to reason about boot
 * history and about who still needs to be told, reads as one thing.
 */
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  formatSubagentOrphanErrorMessage,
  hasRecordedSubagentOutput,
  loadGatewayBootSegmentsForAttribution,
  resolveSubagentOrphanAttribution,
  resolveSubagentRunLastActivityMs,
} from "./subagent-orphan-attribution.js";
import type {
  SubagentCompletionRequest,
  SubagentRecoveryCurrent,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  type SubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

const LOST_CONTEXT_ERROR = "subagent run lost active execution context";
const ORPHAN_COMPLETION_SOURCE = "sweeper-orphaned-by-gateway-death";

/**
 * Settles one stale active run through the canonical completion owner.
 * The caller stops processing this run; cleanup never bypasses canonical completion.
 */
export async function reconcileStaleActiveSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  /**
   * Re-asserts the caller's selection criteria. Boot history is read off the
   * gateway thread, so the run can be replaced or settled across that await;
   * anything learned before it describes a row we may no longer own.
   */
  isCurrent: () => boolean;
  /**
   * The caller's execution authority, carried into every completion request so
   * the controller re-asserts it while it holds the terminal lock and again at
   * publication — not only before this helper was entered.
   */
  recoveryCurrent: SubagentRecoveryCurrent;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
}): Promise<void> {
  const { entry, now, recoveryCurrent, runId } = params;
  const accountId = entry.requesterOrigin?.accountId;
  const runStartedAtMs = entry.execution.startedAt ?? entry.createdAt;
  // Session reads cross the worker, so the selection that chose this row has to
  // survive the await. Retiring here is ordinary: a later sweep re-evaluates.
  const retiredRead = new Error("subagent orphan sweep lost its selected run");
  const assertReadCurrent = () => {
    if (!params.isCurrent()) {
      throw retiredRead;
    }
  };
  let observation: {
    orphanReason: SubagentRunOrphanReason | null;
    sessionEntry: Awaited<ReturnType<typeof loadSubagentSessionEntry>>;
  };
  try {
    assertReadCurrent();
    // One scoped read serves both consumers. The deferred classification
    // already carries the recorded child owner, which raw session keys such as
    // "global" need before an agent id can be resolved at all.
    const classification = resolveSubagentRunOrphanReason({ entry });
    observation =
      typeof classification === "object" && classification !== null
        ? await classification.read(assertReadCurrent)
        : {
            orphanReason: classification,
            sessionEntry: await loadSubagentSessionEntry({
              childSessionKey: entry.childSessionKey,
              childAgentId: entry.childAgentId,
              assertCurrent: assertReadCurrent,
            }),
          };
    assertReadCurrent();
  } catch (error) {
    if (error === retiredRead) {
      return;
    }
    throw error;
  }
  const { orphanReason, sessionEntry } = observation;
  // A fresh persisted terminal state is the child's authoritative outcome.
  // Resolve it before crash attribution so a later gateway death cannot
  // rewrite a real failure, timeout, or kill as an orphan diagnosis.
  const persistedCompletion = resolveCompletionFromSessionEntry(sessionEntry, now, {
    notBeforeMs: runStartedAtMs,
  });
  if (persistedCompletion) {
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        expectedEntry: entry,
        recoveryCurrent,
        startedAt: persistedCompletion.startedAt,
        endedAt: persistedCompletion.endedAt,
        outcome: persistedCompletion.outcome,
        reason: persistedCompletion.reason,
        sendFarewell: true,
        accountId,
        triggerCleanup: true,
      },
      "sweeper-session-completion",
    );
    return;
  }
  // The reap happens arbitrarily long after the death — it includes however
  // long the host stayed down. Correlate against boot history before writing
  // anything about this run: the reap clock is not evidence of its lifetime.
  const boots = await loadGatewayBootSegmentsForAttribution(now);
  if (!params.isCurrent()) {
    // The run was replaced or settled while the history read was in flight.
    // Whoever owns it now is ahead of us; a later sweep re-evaluates it.
    return;
  }
  const hasRecordedOutput = hasRecordedSubagentOutput(entry);
  const currentBootId = boots
    .toReversed()
    .find(
      (boot) => boot.pid === process.pid && boot.completedAtMs === null && boot.outcome === null,
    )?.bootId;
  const attribution = resolveSubagentOrphanAttribution({
    runStartedAtMs,
    lastActivityAtMs: resolveSubagentRunLastActivityMs(entry),
    hasRecordedOutput,
    boots,
    currentBootId,
  });
  const attributedError = attribution ? formatSubagentOrphanErrorMessage(attribution) : undefined;

  // Every orphan settles through canonical completion; missing session
  // metadata never permits direct row or attachment pruning.
  await params.completeSubagentRunWithRecovery(
    {
      runId,
      expectedEntry: entry,
      recoveryCurrent,
      // An attributed death ended when the run died, not when it was found.
      endedAt: attribution?.diedAtMs ?? now,
      outcome: {
        status: "error",
        error:
          attributedError ??
          (orphanReason ? `subagent run orphaned: ${orphanReason}` : LOST_CONTEXT_ERROR),
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      ...(attribution ? { recoverInterrupted: true as const } : {}),
      sendFarewell: true,
      accountId,
      triggerCleanup: true,
    },
    attribution ? ORPHAN_COMPLETION_SOURCE : "sweeper-lost-context",
  );
}
