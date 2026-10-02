import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
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
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  assertSubagentRegistryWriteOutcomeKnown,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

export const finalizeSubagentCleanup = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  observedEntry: SubagentRunRecord,
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
  const publishedEntry = getCurrentSubagentRunOwner(params.runs, observedEntry);
  if (!publishedEntry) {
    return;
  }
  let entry = publishedEntry;
  let runId = entry.runId;
  const runtimeKey = getSubagentRunRuntimeKey(observedEntry);
  if (!context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)) {
    await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    return;
  }
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    assertSubagentRegistryWriteOutcomeKnown([current?.runId ?? runId], stateContext.admission);
    if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
      throw new Error("Subagent cleanup generation changed before persistence.");
    }
    if (current) {
      entry = current;
      runId = current.runId;
    }
  };
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration);
  };
  const commit = async (
    mutate: (draft: SubagentRunRecord) => void | false,
    onPublished?: () => void,
  ) => {
    entry = await commitSubagentLifecycleMutation(context, {
      entry,
      stateContext,
      mutate,
      assertCurrent,
      onPublished,
    });
  };
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
    await commit((draft) => {
      const intentionalNonDelivery = draft.delivery?.disposition === "intentional_non_delivery";
      clearSubagentPendingDelivery(draft);
      if (skipRequesterDelivery) {
        const delivery = ensureDeliveryState(draft);
        delivery.status = "not_required";
        // Preserve the lifecycle owner's terminal fact after cleanup clears retry state.
        delivery.disposition = intentionalNonDelivery ? "intentional_non_delivery" : undefined;
        draft.suppressCompletionDelivery = undefined;
      }
      draft.wakeOnDescendantSettle = undefined;
    });
    await finishCleanup(skipRequesterDelivery);
    return;
  }
  if (announceOutcome === "delivered" || announceOutcome === "intentional_non_delivery") {
    let terminalNonDelivery = false;
    await commit((draft) => {
      terminalNonDelivery =
        announceOutcome === "intentional_non_delivery" && draft.delivery?.status === "failed";
      const delivery = ensureDeliveryState(draft);
      const shouldCreditDelivery =
        announceOutcome === "delivered" || delivery.status === "delivered";
      if (shouldCreditDelivery) {
        const deliveredAt = delivery.deliveredAt ?? delivery.announcedAt ?? Date.now();
        delivery.status = "delivered";
        delivery.deliveredAt = deliveredAt;
        delivery.announcedAt = delivery.announcedAt ?? deliveredAt;
        if (!options?.skipAnnounce) {
          delivery.announcedAt = deliveredAt;
        }
        clearSubagentPendingDelivery(draft);
        delivery.lastDropReason = undefined;
      } else {
        // A handoff stays pending for requester-settle; explicit suppression is
        // terminal and must not start another turn that overrides the decision.
        // Nothing wakes a cron run requester: it reads this row itself.
        delivery.status = terminalNonDelivery
          ? "failed"
          : isCronRunSessionKey(draft.requesterSessionKey)
            ? "not_required"
            : "pending";
        delivery.disposition = "intentional_non_delivery";
        delivery.payload = undefined;
        delivery.createdAt = undefined;
        delivery.attemptCount = undefined;
        delivery.nextAttemptAt = undefined;
      }
      draft.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(draft);
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
      (draft) => {
        draft.cleanupHandled = false;
      },
      () => params.resumedRuns.delete(runtimeKey),
    );
    return;
  }

  const activeDescendantRuns = await params.countPendingDescendantRuns(
    entry.childSessionKey,
    assertCurrent,
  );
  assertCurrent();
  const now = Date.now();
  const decision: {
    value?: ReturnType<typeof resolveDeferredCleanupDecision>;
    delivered?: boolean;
  } = {};
  let resumeDelayMs: number | undefined;
  await commit(
    (draft) => {
      decision.delivered = draft.delivery?.status === "delivered";
      if (decision.delivered) {
        return false;
      }
      const deferredDecision = resolveDeferredCleanupDecision({
        entry: draft,
        now,
        activeDescendantRuns: Math.max(0, activeDescendantRuns),
        announceExpiryMs: ANNOUNCE_EXPIRY_MS,
        announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
        deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
        resolveAnnounceRetryDelayMs,
      });
      decision.value = deferredDecision;
      if (deferredDecision.kind === "give-up") {
        return false;
      }
      if (deferredDecision.kind === "defer-descendants") {
        ensureDeliveryState(draft).lastAttemptAt = now;
        draft.wakeOnDescendantSettle = true;
        resumeDelayMs = deferredDecision.delayMs;
      } else {
        const requesterTurnPending = announceOutcome === "requester_turn_pending";
        if (!requesterTurnPending) {
          markPendingFinalDelivery({
            entry: draft,
            error: "announce deferred or direct delivery failed",
          });
        }
        const delivery = ensureDeliveryState(draft);
        delivery.status = "pending";
        delivery.payload ??= loadPendingFinalDeliveryPayload(draft);
        delivery.windowStartedAt ??= draft.execution.endedAt ?? now;
        delivery.deadlineAt ??= delivery.windowStartedAt + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
        resumeDelayMs = requesterTurnPending
          ? Math.min(MIN_ANNOUNCE_RETRY_DELAY_MS, delivery.deadlineAt - now)
          : deferredDecision.resumeDelayMs;
        delivery.nextAttemptAt = now + (resumeDelayMs ?? 0);
      }
      draft.cleanupHandled = false;
      return undefined;
    },
    () => params.resumedRuns.delete(runtimeKey),
  );
  if (decision.delivered) {
    await finalizeSubagentCleanup(
      context,
      entry,
      cleanup,
      "delivered",
      cleanupGeneration,
      stateContext,
      options,
    );
  } else if (decision.value?.kind === "give-up") {
    await finalizeResumedAnnounceGiveUp(context, {
      runId,
      entry,
      reason: decision.value.reason,
      cleanup,
      cleanupGeneration,
      retryCount: decision.value.retryCount,
      completedAt: now,
      stateContext,
    });
  } else if (resumeDelayMs != null) {
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
