import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import {
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

export const SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT = 25;

export function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry);
}

/** Report delivery backlog changes independently of admission for new work. */
export function warnSuspendedDeliveryPressure(
  entries: Iterable<SubagentRunRecord>,
  previousCount: number | undefined,
  warn: (message: string, meta?: Record<string, unknown>) => void,
): number | undefined {
  let suspendedCount = 0;
  for (const entry of entries) {
    if (isSuspendedPendingFinalDelivery(entry)) {
      suspendedCount += 1;
    }
  }
  if (suspendedCount < SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT) {
    return undefined;
  }
  if (suspendedCount !== previousCount) {
    warn("subagent suspended delivery backlog reached warning threshold", {
      suspendedCount,
      warningThreshold: SUBAGENT_SUSPENDED_DELIVERY_WARNING_COUNT,
    });
  }
  return suspendedCount;
}

export async function discardSuspendedPendingFinalDelivery(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  controller: SubagentLifecycleAnnounceCleanupContext;
  clearPendingLifecycleTimeout: (runId: string) => void;
  isCurrent: () => boolean;
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
}): Promise<void> {
  const { runId, entry, now } = params;
  const { resumedRuns } = params.controller.options;
  const stateContext = captureOpenClawStateWorkerContext();
  const resumeKey = getSubagentRunRuntimeKey(entry);
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return params.isCurrent();
  };
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Subagent suspended delivery cleanup owner changed.");
    }
  };
  assertCurrent();
  const isHookCurrent = () => isCurrent() && params.controller.sessionEffectsHostCurrent(entry);
  const prepareHookCurrent = async () =>
    isHookCurrent() &&
    !(await params.controller.shouldSuppressSessionEffects(entry)) &&
    isHookCurrent();
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  await params.controller.completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: entry.cleanup,
    completedAt: now,
    skipRequesterSettleWake: true,
    stateContext,
    isCurrent,
    finalizeDelivery: (draft) => params.discardTerminalDelivery(draft, now),
  });
  assertCurrent();
  resumedRuns.delete(resumeKey);
  params.controller.options.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  params.controller.options.warn("subagent suspended delivery discarded", {
    reason: "expired",
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
    suspendedAt: entry.delivery?.suspendedAt,
    suspendedReason: entry.delivery?.suspendedReason,
    lastError: entry.delivery?.lastError,
    recovery:
      "Inspect retained results with /subagents info <runId>; session history depends on cleanup and retention.",
  });
  if (shouldRemoveSubagentAttachments(entry) && isHookCurrent()) {
    await safeRemoveAttachmentsDir(entry, isHookCurrent);
  }
  assertCurrent();
  if (
    (await prepareHookCurrent()) &&
    entry.expectsCompletionMessage === true &&
    params.controller.options.shouldEmitEndedHookForRun({ entry, reason: completionReason })
  ) {
    await params.controller.options.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
      isCurrent: isHookCurrent,
      prepareCurrent: prepareHookCurrent,
    });
  }
}
