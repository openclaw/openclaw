import { hasLiveAgentRunContext } from "../../../infra/agent-run-registry.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { recordRequiredCompletionNotice } from "../completion/subagent-completion-admission.store.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { retireSubagentCompletionControllerInput } from "./subagent-controller-inputs.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import { resolveAnnounceDeliveryDeadline } from "./subagent-registry-cleanup.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
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

export async function discardExpiredSubagentDelivery(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  resumedRuns: Set<object>;
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
  const { runId, entry, now, resumedRuns } = params;
  const suspended = isSuspendedPendingFinalDelivery(entry);
  const deferDelete = !suspended && entry.cleanup === "delete";
  const stateContext = captureOpenClawStateWorkerContext();
  const resumeKey = getSubagentRunRuntimeKey(entry);
  const isCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    return params.isCurrent();
  };
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error(
        `Subagent ${suspended ? "suspended" : "expired"} delivery cleanup owner changed.`,
      );
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
    cleanup: entry.cleanup,
    completedAt: now,
    skipRequesterSettleWake: true,
    retainForCleanup: deferDelete,
    stateContext,
    isCurrent,
    finalizeDelivery: (draft) => {
      params.discardTerminalDelivery(draft, now);
      // Idle completion expiry leaves session and attachment deletion to the sweeper.
      if (deferDelete) {
        draft.archiveAtMs = now;
      }
    },
  });
  assertCurrent();
  retireSubagentCompletionControllerInput(entry);
  resumedRuns.delete(resumeKey);
  params.clearPendingLifecycleError(runId);
  params.clearPendingLifecycleTimeout(runId);
  params.warn(`subagent ${suspended ? "suspended" : "completion"} delivery discarded`, {
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
  try {
    if (
      !deferDelete &&
      shouldRemoveSubagentAttachments(entry) &&
      (suspended ? isHookCurrent() : await prepareHookCurrent())
    ) {
      await safeRemoveAttachmentsDir(entry, isHookCurrent);
    }
    assertCurrent();
    if (
      suspended &&
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
  } finally {
    // Retiring the obligation is the final failure: the requester sees it, not only the log.
    // The discard is already committed, so the notice is best-effort and cannot undo it.
    await recordRequiredCompletionNotice(entry, "expired").catch((error: unknown) => {
      params.warn("subagent expiry notice could not be recorded", {
        runId: entry.runId,
        requesterSessionKey: entry.requesterSessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/** Idle expiry retires the same result obligation as suspended delivery. */
export async function settleSubagentCompletionReservation(
  entry: SubagentRunRecord,
  now: number,
  lifecycle: Omit<
    Parameters<typeof discardExpiredSubagentDelivery>[0],
    "runId" | "entry" | "now" | "isCurrent"
  > & {
    isCleanupOwnerCurrent: (entry: SubagentRunRecord) => boolean;
    isTerminalTailActive: (entry: SubagentRunRecord) => boolean;
  },
): Promise<boolean> {
  if (resolveSubagentChildAuthority(entry).status === "mismatch") {
    retireSubagentCompletionControllerInput(entry);
    return true;
  }
  if (
    entry.execution.status !== "terminal" ||
    typeof entry.execution.endedAt !== "number" ||
    entry.expectsCompletionMessage !== true ||
    (entry.delivery?.status !== "pending" && entry.delivery?.status !== "in_progress") ||
    entry.delivery.queueId ||
    entry.pauseReason === "sessions_yield" ||
    entry.requesterSettleWake ||
    entry.killIntent ||
    entry.killReconciliation ||
    subagentRuns.isCompletionAuthorityRetired(entry) ||
    lifecycle.isTerminalTailActive(entry) ||
    hasLiveAgentRunContext(entry.runId) ||
    resolveAnnounceDeliveryDeadline(entry, now, ANNOUNCE_COMPLETION_HARD_EXPIRY_MS) > now
  ) {
    return false;
  }
  await discardExpiredSubagentDelivery({
    ...lifecycle,
    runId: entry.runId,
    entry,
    now,
    isCurrent: () => lifecycle.isCleanupOwnerCurrent(entry),
  });
  return true;
}
