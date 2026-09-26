import {
  getDeliveryLastError,
  ensureDeliveryState,
  ensureCompletionState,
} from "./subagent-delivery-state.js";
import {
  resolveCleanupCompletionReason,
  shouldSuspendPendingFinalDelivery,
} from "./subagent-registry-cleanup.js";
import { logAnnounceGiveUp, safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import {
  suspendPendingFinalDelivery,
  retireSupersededCleanupIfNeeded,
} from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import {
  clearSubagentPendingDelivery,
  emitCompletionEndedHookIfNeeded,
} from "./subagent-registry-lifecycle-delivery.js";
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
  },
) => {
  const params = context.options;
  const { runId, entry, reason, cleanup, cleanupGeneration, retryCount, completedAt } =
    giveUpParams;
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
  if ((cleanup ?? entry.cleanup) === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry);
  }
  if (
    cleanupGeneration !== undefined &&
    !context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration)
  ) {
    await retireSupersededCleanupIfNeeded(context, runId, entry, cleanupGeneration);
    return;
  }
  const completionReason = resolveCleanupCompletionReason(entry);
  logAnnounceGiveUp(entry, reason);
  // Retry-limit / expiry give-up should not leave cleanup stuck behind the
  // best-effort ended hook. Mark the run cleaned first, then fire the hook.
  context.completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: cleanup ?? entry.cleanup,
    completedAt: completedAt ?? Date.now(),
  });
  if (!context.shouldSuppressSessionEffects(entry)) {
    await emitCompletionEndedHookIfNeeded(
      params,
      entry,
      completionReason,
      () =>
        context.isEndedHookOwnerCurrent(runId, entry) &&
        !context.shouldSuppressSessionEffects(entry),
    );
  }
};
