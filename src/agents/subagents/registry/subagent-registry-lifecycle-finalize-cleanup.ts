import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentAnnounceFlowOutcome } from "../announce/subagent-announce.js";
import {
  getDeliveryLastError,
  ensureCompletionState,
  ensureDeliveryState,
  clearSubagentPendingDelivery,
  loadPendingFinalDeliveryPayload,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveAnnounceDeliveryDeadline,
  resolveDeferredCleanupDecision,
  shouldSuspendPendingFinalDelivery,
} from "./subagent-registry-cleanup.js";
import {
  logAnnounceGiveUp,
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import {
  retireSupersededCleanupIfNeeded,
  scheduleResumeSubagentRun,
  suspendPendingFinalDelivery,
} from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
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
  const runtimeKey = getSubagentRunRuntimeKey(observedEntry);
  if (!context.isCleanupAttemptCurrent(entry, cleanupGeneration)) {
    await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
    return;
  }
  const assertCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    assertSubagentRegistryWriteOutcomeKnown(
      [current?.runId ?? entry.runId],
      stateContext.admission,
    );
    if (!context.isCleanupGenerationCurrent(entry, cleanupGeneration)) {
      throw new Error("Subagent cleanup generation changed before persistence.");
    }
    if (current) {
      entry = current;
    }
  };
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return context.isCleanupAttemptCurrent(entry, cleanupGeneration);
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

  // Expiry settles delivery regardless of descendants; failed preparation must not block it.
  const expiryMs =
    entry.expectsCompletionMessage === true
      ? ANNOUNCE_COMPLETION_HARD_EXPIRY_MS
      : ANNOUNCE_EXPIRY_MS;
  const expired = Date.now() >= resolveAnnounceDeliveryDeadline(entry, Date.now(), expiryMs);
  const activeDescendantRuns = expired
    ? 0
    : await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent);
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
        const delivery = ensureDeliveryState(draft);
        if (!requesterTurnPending) {
          const attemptedAt = Date.now();
          delivery.payload = loadPendingFinalDeliveryPayload(draft);
          delivery.createdAt ??= attemptedAt;
          delivery.lastAttemptAt = attemptedAt;
          delivery.attemptCount = (delivery.attemptCount ?? 0) + 1;
          delivery.lastError = "announce deferred or direct delivery failed";
        }
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
      entry,
      reason: decision.value.reason,
      cleanup,
      cleanupGeneration,
      retryCount: decision.value.retryCount,
      completedAt: now,
      stateContext,
    });
  } else if (resumeDelayMs != null) {
    scheduleResumeSubagentRun(context, entry, resumeDelayMs, cleanupGeneration, stateContext);
  }
};

export const finalizeResumedAnnounceGiveUp = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  giveUpParams: {
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    cleanup?: "delete" | "keep";
    cleanupGeneration?: number;
    retryCount?: number;
    completedAt?: number;
    stateContext?: OpenClawStateWorkerContext;
  },
) => {
  const params = context.options;
  const { reason, cleanup, cleanupGeneration, retryCount, completedAt } = giveUpParams;
  let entry = giveUpParams.entry;
  const stateContext = giveUpParams.stateContext ?? captureOpenClawStateWorkerContext();
  const generation = entry.generation;
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    if (!current) {
      return false;
    }
    entry = current;
    return (
      entry.generation === generation &&
      (cleanupGeneration === undefined || context.isCleanupAttemptCurrent(entry, cleanupGeneration))
    );
  };
  if (!isCurrent()) {
    return;
  }
  if (shouldSuspendPendingFinalDelivery(entry)) {
    await suspendPendingFinalDelivery(context, {
      runId: entry.runId,
      entry,
      reason,
      error: getDeliveryLastError(entry),
    });
    return;
  }
  entry = await commitSubagentLifecycleMutation(context, {
    entry,
    stateContext,
    assertCurrent() {
      if (
        cleanupGeneration !== undefined &&
        !context.isCleanupGenerationCurrent(entry, cleanupGeneration)
      ) {
        throw new Error("Subagent give-up owner changed before persistence.");
      }
    },
    mutate(draft) {
      if (draft.delivery?.status === "delivered") {
        return false;
      }
      const deliveryError = getDeliveryLastError(draft) ?? reason;
      clearSubagentPendingDelivery(draft);
      const failedDelivery = ensureDeliveryState(draft);
      failedDelivery.status = "failed";
      failedDelivery.lastError = deliveryError;
      if (retryCount != null) {
        failedDelivery.attemptCount = retryCount;
        failedDelivery.lastAttemptAt = completedAt ?? Date.now();
      }
      draft.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(draft);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
      return undefined;
    },
  });
  if (entry.delivery?.status === "delivered") {
    return;
  }
  await finishSubagentCleanup(context, {
    entry,
    cleanup: cleanup ?? entry.cleanup,
    cleanupGeneration,
    generation,
    completedAt,
    stateContext,
    isCurrent,
    giveUpReason: reason,
  });
};

async function finishSubagentCleanup(
  context: SubagentLifecycleAnnounceCleanupContext,
  args: {
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    cleanupGeneration?: number;
    generation?: number;
    completedAt?: number;
    stateContext: OpenClawStateWorkerContext;
    isCurrent: () => boolean;
    skipRequesterSettleWake?: boolean;
    completionReason?: SubagentLifecycleEndedReason;
    giveUpReason?: "expiry" | "permanent_failure";
  },
): Promise<void> {
  const { cleanup, cleanupGeneration, stateContext, isCurrent } = args;
  let entry = args.entry;
  const sessionEffectsCurrent = () => isCurrent() && context.sessionEffectsHostCurrent(entry);
  if (shouldRemoveSubagentAttachments(entry, cleanup) && sessionEffectsCurrent()) {
    await safeRemoveAttachmentsDir(entry, sessionEffectsCurrent);
  }
  if (!isCurrent()) {
    if (cleanupGeneration !== undefined) {
      await retireSupersededCleanupIfNeeded(context, entry, cleanupGeneration);
    }
    return;
  }
  entry = getCurrentSubagentRunOwner(context.options.runs, entry) ?? entry;
  let completionReason = args.completionReason;
  if (args.giveUpReason) {
    completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
    logAnnounceGiveUp(entry, args.giveUpReason);
  }
  const cleanupOwnerCurrent = () =>
    (cleanupGeneration === undefined || context.isCleanupGeneration(entry, cleanupGeneration)) &&
    context.isCleanupOwnerCurrent(entry);
  // Hook loading is best-effort; durable delivery and cleanup must already
  // be terminal before plugin code can fail or stall.
  await context.completeCleanupBookkeeping({
    runId: entry.runId,
    entry,
    cleanup,
    completedAt: args.completedAt ?? Date.now(),
    skipRequesterSettleWake: args.skipRequesterSettleWake,
    stateContext,
    isCurrent: cleanupOwnerCurrent,
  });
  entry = getCurrentSubagentRunOwner(context.options.runs, entry) ?? entry;
  const endedHookOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return (
      (!args.giveUpReason || entry.generation === args.generation) &&
      cleanupOwnerCurrent() &&
      context.sessionEffectsHostCurrent(entry)
    );
  };
  if (!(await context.shouldSuppressSessionEffects(entry)) && endedHookOwnerCurrent()) {
    const reason = completionReason ?? entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
    if (context.options.shouldEmitEndedHookForRun({ entry, reason })) {
      await context.options.emitSubagentEndedHookForRun({
        entry,
        reason,
        sendFarewell: true,
        isCurrent: endedHookOwnerCurrent,
        prepareCurrent: async () =>
          !(await context.shouldSuppressSessionEffects(entry)) && endedHookOwnerCurrent(),
      });
    }
  }
}
