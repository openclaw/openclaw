import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import {
  resolveEffectiveCleanupMode,
  shouldDeleteSubagentAttachments,
} from "./subagent-registry-cleanup.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
  resumedRuns: Set<string>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  isCurrent: () => boolean;
  sessionEffectsHostCurrent: SubagentLifecycleController["sessionEffectsHostCurrent"];
  shouldSuppressSessionEffects: SubagentLifecycleController["shouldSuppressSessionEffects"];
  shouldEmitEndedHookForRun: SubagentLifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: SubagentLifecycleOptions["emitSubagentEndedHookForRun"];
  warn: (message: string, meta?: Record<string, unknown>) => void;
}): Promise<void> {
  const { runId, entry, now, reason, resumedRuns } = params;
  const stateContext = captureOpenClawStateWorkerContext();
  const generation = entry.generation;
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
  await params.completeCleanupBookkeeping({
    runId,
    entry,
    // Retention expiry legitimately owns abandoning the stale *delivery*, but a
    // seven-day clock is not evidence that the child stopped. Resolve the mode
    // the same way every other cleanup owner does: an unconfirmed child
    // downgrades to `keep`, which is what keeps `retireAfterSettle` from
    // running `runs.delete(runId)` on this row. Retiring it would be worse than
    // the attachment loss — promotion resolves the run by id, so a retired row
    // can never be promoted by a later observed stop at all.
    cleanup: resolveEffectiveCleanupMode(entry),
    completedAt: now,
    skipRequesterSettleWake: true,
    stateContext,
    isCurrent,
    discardDelivery: () => params.discardTerminalDelivery(entry, now, reason),
  });
  assertCurrent();
  resumedRuns.delete(runId);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  params.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  // Same decision, one owner: the hand-rolled copy of this condition was how
  // this path escaped the provisional-child guard. A live child may still be
  // writing here, and a later promotion can reopen bookkeeping but cannot
  // recreate a removed directory.
  if (shouldDeleteSubagentAttachments(entry)) {
    await safeRemoveAttachmentsDir(entry, isCurrent);
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
