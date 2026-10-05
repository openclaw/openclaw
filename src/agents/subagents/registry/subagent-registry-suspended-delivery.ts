import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import {
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
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
  reason: "expired";
  resumedRuns: Set<object>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  deleteSuspendedSubagentSession: SubagentLifecycleController["deleteSuspendedSubagentSession"];
  isCurrent: () => boolean;
  sessionEffectsHostCurrent: SubagentLifecycleController["sessionEffectsHostCurrent"];
  shouldSuppressSessionEffects: SubagentLifecycleController["shouldSuppressSessionEffects"];
  shouldEmitEndedHookForRun: SubagentLifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: SubagentLifecycleOptions["emitSubagentEndedHookForRun"];
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const { runId, now, reason, resumedRuns } = params;
  let entry = params.entry;
  const stateContext = captureOpenClawStateWorkerContext();
  const generation = entry.generation;
  const resumeKey = getSubagentRunRuntimeKey(entry);
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return entry.generation === generation && params.isCurrent();
  };
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Subagent suspended delivery cleanup owner changed.");
    }
  };
  assertCurrent();
  const isHookCurrent = () => isCurrent() && params.sessionEffectsHostCurrent(entry);
  const prepareHookCurrent = async () =>
    isHookCurrent() && !(await params.shouldSuppressSessionEffects(entry)) && isHookCurrent();
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  entry = await params.deleteSuspendedSubagentSession({ entry, stateContext, isCurrent });
  assertCurrent();
  await params.completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: entry.cleanup,
    completedAt: now,
    skipRequesterSettleWake: true,
    stateContext,
    isCurrent,
    discardDelivery: (draft) => params.discardTerminalDelivery(draft, now, reason),
  });
  assertCurrent();
  resumedRuns.delete(resumeKey);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  params.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  if (shouldRemoveSubagentAttachments(entry) && isHookCurrent()) {
    await safeRemoveAttachmentsDir(entry, isHookCurrent);
  }
  assertCurrent();
  if (
    (await prepareHookCurrent()) &&
    entry.expectsCompletionMessage === true &&
    params.shouldEmitEndedHookForRun({ entry, reason: completionReason })
  ) {
    await params.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
      isCurrent: isHookCurrent,
      prepareCurrent: prepareHookCurrent,
    });
  }
}
