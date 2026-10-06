import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  getDeliveryLastError,
  clearSubagentPendingDelivery,
  ensureDeliveryState,
  ensureCompletionState,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { shouldSuspendPendingFinalDelivery } from "./subagent-registry-cleanup.js";
import {
  logAnnounceGiveUp,
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import { retireSupersededCleanupIfNeeded } from "./subagent-registry-lifecycle-attempt.js";
import { suspendPendingFinalDelivery } from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { getCurrentSubagentRunOwner } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
  let runId = entry.runId;
  const stateContext = giveUpParams.stateContext ?? captureOpenClawStateWorkerContext();
  const generation = entry.generation;
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    const current = getCurrentSubagentRunOwner(params.runs, entry);
    if (!current) {
      return false;
    }
    entry = current;
    runId = entry.runId;
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
      runId,
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

export async function finishSubagentCleanup(
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
  const completionReason = args.giveUpReason
    ? (entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE)
    : args.completionReason;
  if (args.giveUpReason) {
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
