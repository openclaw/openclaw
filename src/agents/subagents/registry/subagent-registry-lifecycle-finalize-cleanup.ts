import { isGatewayRestartDraining } from "../../../process/gateway-work-admission.js";
import { isCronRunSessionKey } from "../../../sessions/session-key-utils.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { SubagentAnnounceFlowOutcome } from "../announce/subagent-announce.js";
import { settleSubagentCompletionInHistory } from "../completion/subagent-completion-admission.store.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  clearSubagentPendingDelivery,
  recordRequesterHandoff,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { resolveAnnounceDeliveryDeadline } from "./subagent-registry-cleanup.js";
import {
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
  GATEWAY_ADMISSION_RETRY_DELAY_MS,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
} from "./subagent-registry-helpers.js";
import {
  retireSupersededCleanupIfNeeded,
  scheduleResumeSubagentRun,
} from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  assertSubagentRegistryWriteOutcomeKnown,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

/** A drain refusal retries only while the same unfinished owner still holds the row. */
function retainsSubagentRetryAfterDrain(
  context: SubagentLifecycleAnnounceCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
): boolean {
  const current = context.options.runs.get(runId);
  return (
    isGatewayRestartDraining() &&
    isSameSubagentRunOwner(current, entry) &&
    typeof current?.cleanupCompletedAt !== "number"
  );
}

export function resumeSubagentAfterDrain(
  context: SubagentLifecycleAnnounceCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  stateContext: OpenClawStateWorkerContext,
): void {
  if (retainsSubagentRetryAfterDrain(context, runId, entry)) {
    scheduleResumeSubagentRun(
      context,
      entry,
      GATEWAY_ADMISSION_RETRY_DELAY_MS,
      undefined,
      stateContext,
    );
    context.options.resumedRuns.add(getSubagentRunRuntimeKey(entry));
  }
}

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
    finalizeDelivery?: (draft: SubagentRunRecord) => void,
  ) =>
    finishSubagentCleanup(context, {
      entry,
      cleanup,
      cleanupGeneration,
      stateContext,
      isCurrent,
      skipRequesterSettleWake,
      completionReason,
      finalizeDelivery,
    });
  if (entry.expectsCompletionMessage === false || skipRequesterDelivery) {
    const finalizeDelivery = (draft: SubagentRunRecord) => {
      clearSubagentPendingDelivery(draft);
      if (skipRequesterDelivery) {
        const delivery = ensureDeliveryState(draft);
        if (delivery.status !== "delivered") {
          delivery.status = "not_required";
          delivery.disposition = undefined;
        }
        draft.suppressCompletionDelivery = undefined;
      }
      draft.wakeOnDescendantSettle = undefined;
    };
    await finishCleanup(skipRequesterDelivery, undefined, finalizeDelivery);
    return;
  }
  if (announceOutcome === "delivered" || announceOutcome === "requester_waiting") {
    const finalizeDelivery = (draft: SubagentRunRecord) => {
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
        // A handoff stays pending for requester-settle.
        // Nothing wakes a cron run requester: it reads this row itself.
        delivery.status = isCronRunSessionKey(draft.requesterSessionKey)
          ? "not_required"
          : "pending";
        delivery.disposition = undefined;
        if (delivery.status === "pending") {
          recordRequesterHandoff(draft);
        }
        delivery.payload = undefined;
        delivery.createdAt = undefined;
        delivery.attemptCount = undefined;
        delivery.nextAttemptAt = undefined;
      }
      draft.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(draft);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
    };
    if (announceOutcome === "delivered") {
      // The send receipt is already durable; finish its bookkeeping in one write.
      await finishCleanup(
        false,
        entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE,
        finalizeDelivery,
      );
    } else {
      await commit(finalizeDelivery);
      await finishCleanup(false, entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE);
    }
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

  if (entry.delivery?.status === "delivered") {
    await finalizeSubagentCleanup(
      context,
      entry,
      cleanup,
      "delivered",
      cleanupGeneration,
      stateContext,
      options,
    );
    return;
  }
  // Expiry settles delivery regardless of descendants; failed preparation must not block it.
  const expired = Date.now() >= resolveAnnounceDeliveryDeadline(entry, Date.now());
  // Settled descendant delivery cannot hold this completion for unfinished cleanup.
  const activeDescendantRuns = expired
    ? 0
    : await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent, {
        excludeSettledDelivery: true,
      });
  assertCurrent();
  if (activeDescendantRuns <= 0) {
    // A result that missed its turn settles into requester history; nothing retries it.
    await finalizeResumedAnnounceGiveUp(context, {
      entry,
      cleanup,
      cleanupGeneration,
      completedAt: Date.now(),
      stateContext,
    });
    return;
  }
  await commit(
    (draft) => {
      ensureDeliveryState(draft).lastAttemptAt = Date.now();
      draft.wakeOnDescendantSettle = true;
      draft.cleanupHandled = false;
    },
    () => params.resumedRuns.delete(runtimeKey),
  );
  // Descendants may settle while this attempt still owns the deferred-state write.
  if (
    (await params.countPendingDescendantRuns(entry.childSessionKey, assertCurrent, {
      excludeSettledDelivery: true,
    })) === 0
  ) {
    assertCurrent();
    params.resumeSubagentRun(entry.runId);
  } else {
    scheduleResumeSubagentRun(
      context,
      entry,
      MIN_ANNOUNCE_RETRY_DELAY_MS,
      cleanupGeneration,
      stateContext,
    );
  }
};

/** The child's status entry in requester history is the delivery; cleanup then finishes. */
export const finalizeResumedAnnounceGiveUp = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  giveUpParams: {
    entry: SubagentRunRecord;
    cleanup?: "delete" | "keep";
    cleanupGeneration?: number;
    completedAt?: number;
    stateContext?: OpenClawStateWorkerContext;
  },
) => {
  const params = context.options;
  const { cleanup, cleanupGeneration, completedAt } = giveUpParams;
  let entry = giveUpParams.entry;
  const stateContext = giveUpParams.stateContext ?? captureOpenClawStateWorkerContext();
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    if (!current) {
      return false;
    }
    entry = current;
    return (
      cleanupGeneration === undefined || context.isCleanupAttemptCurrent(entry, cleanupGeneration)
    );
  };
  if (!isCurrent()) {
    return;
  }
  const settled = await settleSubagentCompletionInHistory({ subagent: entry });
  entry = getCurrentSubagentRunOwner(params.runs, entry) ?? entry;
  if (!settled) {
    if (entry.delivery?.status === "delivered") {
      return;
    }
    throw new Error(`subagent completion settlement lost its owner: ${entry.runId}`);
  }
  await finishSubagentCleanup(context, {
    entry,
    cleanup: cleanup ?? entry.cleanup,
    cleanupGeneration,
    completedAt,
    stateContext,
    isCurrent,
    completionReason: entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE,
  });
};

async function finishSubagentCleanup(
  context: SubagentLifecycleAnnounceCleanupContext,
  args: {
    entry: SubagentRunRecord;
    cleanup: "delete" | "keep";
    cleanupGeneration?: number;
    completedAt?: number;
    stateContext: OpenClawStateWorkerContext;
    isCurrent: () => boolean;
    skipRequesterSettleWake?: boolean;
    completionReason?: SubagentLifecycleEndedReason;
    finalizeDelivery?: (draft: SubagentRunRecord) => void;
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
  const completionReason = args.completionReason;
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
    finalizeDelivery: args.finalizeDelivery,
  });
  entry = getCurrentSubagentRunOwner(context.options.runs, entry) ?? entry;
  const endedHookOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return cleanupOwnerCurrent() && context.sessionEffectsHostCurrent(entry);
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
