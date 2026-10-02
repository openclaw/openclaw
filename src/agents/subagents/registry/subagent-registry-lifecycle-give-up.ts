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
import { logAnnounceGiveUp, safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import { retireSupersededCleanupIfNeeded } from "./subagent-registry-lifecycle-attempt.js";
import { suspendPendingFinalDelivery } from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { emitCompletionEndedHookIfNeeded } from "./subagent-registry-lifecycle-delivery.js";
import { commitSubagentLifecycleMutation } from "./subagent-registry-lifecycle-persistence.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export const finalizeResumedAnnounceGiveUp = async (
  context: SubagentLifecycleAnnounceCleanupContext,
  giveUpParams: {
    runId: string;
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
  const { runId, entry, reason, cleanup, cleanupGeneration, retryCount, completedAt } =
    giveUpParams;
  const stateContext = giveUpParams.stateContext ?? captureOpenClawStateWorkerContext();
  const generation = entry.generation;
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return (
      params.runs.get(runId) === entry &&
      entry.generation === generation &&
      (cleanupGeneration === undefined ||
        context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration))
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
  const deliveryError = getDeliveryLastError(entry) ?? reason;
  await commitSubagentLifecycleMutation(context, {
    entry,
    stateContext,
    assertCurrent() {
      if (
        cleanupGeneration !== undefined &&
        !context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)
      ) {
        throw new Error("Subagent give-up owner changed before persistence.");
      }
    },
    mutate() {
      clearSubagentPendingDelivery(entry);
      const failedDelivery = ensureDeliveryState(entry);
      failedDelivery.status = "failed";
      failedDelivery.lastError = deliveryError;
      if (retryCount != null) {
        failedDelivery.attemptCount = retryCount;
        failedDelivery.lastAttemptAt = completedAt ?? Date.now();
      }
      entry.wakeOnDescendantSettle = undefined;
      const completion = ensureCompletionState(entry);
      completion.fallbackResultText = undefined;
      completion.fallbackCapturedAt = undefined;
    },
  });
  await finishSubagentCleanup(context, {
    runId,
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
    runId: string;
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
  const { runId, entry, cleanup, cleanupGeneration, stateContext, isCurrent } = args;
  if (cleanup === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry, isCurrent);
  }
  if (!isCurrent()) {
    if (cleanupGeneration !== undefined) {
      await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    }
    return;
  }
  const completionReason = args.giveUpReason
    ? (entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE)
    : args.completionReason;
  if (args.giveUpReason) {
    logAnnounceGiveUp(entry, args.giveUpReason);
  }
  const cleanupOwnerCurrent = () =>
    (cleanupGeneration === undefined || context.isCleanupGeneration(entry, cleanupGeneration)) &&
    context.isEndedHookOwnerCurrent(runId, entry);
  // Hook loading is best-effort; durable delivery and cleanup must already
  // be terminal before plugin code can fail or stall.
  await context.completeCleanupBookkeeping({
    runId,
    entry,
    cleanup,
    completedAt: args.completedAt ?? Date.now(),
    skipRequesterSettleWake: args.skipRequesterSettleWake,
    stateContext,
    isCurrent: cleanupOwnerCurrent,
  });
  const endedHookOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return (
      (!args.giveUpReason || entry.generation === args.generation) &&
      cleanupOwnerCurrent() &&
      context.sessionEffectsHostCurrent(entry)
    );
  };
  if (!(await context.shouldSuppressSessionEffects(entry)) && endedHookOwnerCurrent()) {
    await emitCompletionEndedHookIfNeeded(
      context.options,
      entry,
      completionReason ?? entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE,
      endedHookOwnerCurrent,
      async () => !(await context.shouldSuppressSessionEffects(entry)) && endedHookOwnerCurrent(),
    );
  }
}
