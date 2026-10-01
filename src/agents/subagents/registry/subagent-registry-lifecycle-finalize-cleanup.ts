import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentAnnounceFlowOutcome } from "../announce/subagent-announce.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  clearSubagentPendingDelivery,
  loadPendingFinalDeliveryPayload,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import {
  retireSupersededCleanupIfNeeded,
  scheduleResumeSubagentRun,
} from "./subagent-registry-lifecycle-attempt.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { markPendingFinalDelivery } from "./subagent-registry-lifecycle-delivery.js";
import {
  finalizeResumedAnnounceGiveUp,
  finishSubagentCleanup,
} from "./subagent-registry-lifecycle-give-up.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  assertSubagentRegistryWriteOutcomeKnown,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const finalizeSubagentCleanup = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  entry: SubagentRunRecord,
  cleanup: "delete" | "keep",
  announceOutcome: SubagentAnnounceFlowOutcome,
  cleanupGeneration: number,
  stateContext: OpenClawStateWorkerContext,
  options?: {
    skipAnnounce?: boolean;
    skipRequesterDelivery?: boolean;
  },
) => {
  const params = context.options;
  assertSubagentRegistryWriteSourceCurrent(stateContext);
  const { runId } = entry;
  if (params.runs.get(runId) !== entry) {
    return;
  }
  if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
    await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    return;
  }
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    assertSubagentRegistryWriteOutcomeKnown([runId], stateContext.admission);
    if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
      throw new Error("Subagent cleanup generation changed before persistence.");
    }
  };
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration);
  };
  const commit = (mutate: () => void, onPublished?: () => void) =>
    commitSubagentLifecycleMutation(context, {
      entry,
      stateContext,
      mutate,
      assertCurrent,
      onPublished,
    });
  assertCurrent();
  const skipRequesterDelivery =
    options?.skipRequesterDelivery === true || entry.suppressCompletionDelivery === true;
  const finishCleanup = (
    skipRequesterSettleWake: boolean,
    completionReason?: SubagentLifecycleEndedReason,
  ) =>
    finishSubagentCleanup(context, {
      runId,
      entry,
      cleanup,
      cleanupGeneration,
      stateContext,
      isCurrent,
      skipRequesterSettleWake,
      completionReason,
    });
  if (entry.expectsCompletionMessage === false || skipRequesterDelivery) {
    const intentionalNonDelivery = entry.delivery?.disposition === "intentional_non_delivery";
    await commit(() => {
      clearSubagentPendingDelivery(entry);
      if (skipRequesterDelivery) {
        const delivery = ensureDeliveryState(entry);
        delivery.status = "not_required";
        // Preserve the lifecycle owner's terminal fact after cleanup clears retry state.
        delivery.disposition = intentionalNonDelivery ? "intentional_non_delivery" : undefined;
        entry.suppressCompletionDelivery = undefined;
      }
      entry.wakeOnDescendantSettle = undefined;
    });
    await finishCleanup(skipRequesterDelivery);
    return;
  }
  if (announceOutcome === "delivered" || announceOutcome === "intentional_non_delivery") {
    const terminalNonDelivery =
      announceOutcome === "intentional_non_delivery" && entry.delivery?.status === "failed";
    await commit(() => {
      const delivery = ensureDeliveryState(entry);
      const shouldCreditDelivery = announceOutcome === "delivered";
      if (shouldCreditDelivery) {
        const deliveredAt = delivery.deliveredAt ?? delivery.announcedAt ?? Date.now();
        delivery.status = "delivered";
        delivery.deliveredAt = deliveredAt;
        delivery.announcedAt = delivery.announcedAt ?? deliveredAt;
        if (!options?.skipAnnounce) {
          delivery.announcedAt = deliveredAt;
        }
        clearSubagentPendingDelivery(entry);
        delivery.lastDropReason = undefined;
      } else {
        // A handoff stays pending for requester-settle; explicit suppression is
        // terminal and must not start another turn that overrides the decision.
        delivery.status = terminalNonDelivery ? "failed" : "pending";
        delivery.disposition = "intentional_non_delivery";
        delivery.payload = undefined;
        delivery.createdAt = undefined;
        delivery.attemptCount = undefined;
        delivery.nextAttemptAt = undefined;
      }
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
    });
    await finishCleanup(terminalNonDelivery, entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE);
    return;
  }

  if (announceOutcome === "session_queued") {
    // The correlated queue owns transport now. Settlement, not admission,
    // decides delivered versus blocked and re-enters cleanup afterward.
    await commit(
      () => {
        entry.cleanupHandled = false;
      },
      () => params.resumedRuns.delete(runId),
    );
    return;
  }

  const activeDescendantRuns = await params.countPendingDescendantRuns(
    entry.childSessionKey,
    assertCurrent,
  );
  assertCurrent();
  const now = Date.now();
  const deferredDecision = resolveDeferredCleanupDecision({
    entry,
    now,
    activeDescendantRuns: Math.max(0, activeDescendantRuns),
    announceExpiryMs: ANNOUNCE_EXPIRY_MS,
    announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
    resolveAnnounceRetryDelayMs,
  });

  if (deferredDecision.kind === "defer-descendants") {
    await commit(
      () => {
        ensureDeliveryState(entry).lastAttemptAt = now;
        entry.wakeOnDescendantSettle = true;
        entry.cleanupHandled = false;
      },
      () => params.resumedRuns.delete(runId),
    );
    scheduleResumeSubagentRun(
      context,
      runId,
      entry,
      deferredDecision.delayMs,
      cleanupGeneration,
      stateContext,
    );
    return;
  }

  if (deferredDecision.kind === "give-up") {
    await finalizeResumedAnnounceGiveUp(context, {
      runId,
      entry,
      reason: deferredDecision.reason,
      cleanup,
      cleanupGeneration,
      retryCount: deferredDecision.retryCount,
      completedAt: now,
      stateContext,
    });
    return;
  }

  const requesterTurnPending = announceOutcome === "requester_turn_pending";
  let resumeDelayMs: number | undefined;
  await commit(
    () => {
      if (!requesterTurnPending) {
        markPendingFinalDelivery({
          entry,
          error: "announce deferred or direct delivery failed",
        });
      }
      const delivery = ensureDeliveryState(entry);
      delivery.status = "pending";
      delivery.payload ??= loadPendingFinalDeliveryPayload(entry);
      delivery.windowStartedAt ??= entry.execution.endedAt ?? now;
      delivery.deadlineAt ??= delivery.windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
      // An admitted requester still owns this delivery; observation is not another failed attempt.
      resumeDelayMs = requesterTurnPending
        ? Math.min(MIN_ANNOUNCE_RETRY_DELAY_MS, delivery.deadlineAt - now)
        : deferredDecision.resumeDelayMs;
      delivery.nextAttemptAt = now + (resumeDelayMs ?? 0);
      entry.cleanupHandled = false;
    },
    () => params.resumedRuns.delete(runId),
  );
  if (resumeDelayMs != null) {
    scheduleResumeSubagentRun(
      context,
      runId,
      entry,
      resumeDelayMs,
      cleanupGeneration,
      stateContext,
    );
  }
};
