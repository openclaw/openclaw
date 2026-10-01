import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  getDeliveryLastError,
  clearSubagentPendingDelivery,
  ensureDeliveryState,
  ensureCompletionState,
} from "./subagent-delivery-state.js";
import {
  resolveCleanupCompletionReason,
  shouldSuspendPendingFinalDelivery,
} from "./subagent-registry-cleanup.js";
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
  if ((cleanup ?? entry.cleanup) === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry, isCurrent);
  }
  if (!isCurrent()) {
    if (cleanupGeneration !== undefined) {
      await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    }
    return;
  }
  const completionReason = resolveCleanupCompletionReason(entry);
  logAnnounceGiveUp(entry, reason);
  // Retry-limit / expiry give-up should not leave cleanup stuck behind the
  // best-effort ended hook. Mark the run cleaned first, then fire the hook.
  await context.completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: cleanup ?? entry.cleanup,
    completedAt: completedAt ?? Date.now(),
    stateContext,
    isCurrent: () =>
      (cleanupGeneration === undefined || context.isCleanupGeneration(entry, cleanupGeneration)) &&
      context.isEndedHookOwnerCurrent(runId, entry),
  });
  const endedHookOwnerCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return (
      entry.generation === generation &&
      (cleanupGeneration === undefined || context.isCleanupGeneration(entry, cleanupGeneration)) &&
      context.isEndedHookOwnerCurrent(runId, entry) &&
      context.sessionEffectsHostCurrent(entry)
    );
  };
  if (!(await context.shouldSuppressSessionEffects(entry)) && endedHookOwnerCurrent()) {
    await emitCompletionEndedHookIfNeeded(
      params,
      entry,
      completionReason,
      endedHookOwnerCurrent,
      async () => !(await context.shouldSuppressSessionEffects(entry)) && endedHookOwnerCurrent(),
    );
  }
};
