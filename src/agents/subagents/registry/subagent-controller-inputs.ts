import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { hasLiveAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  abortSessionControllerInput,
  sessionControllerMailboxes,
} from "../../../sessions/session-controller.mailbox.js";
import {
  matchesSubagentChildSessionOwner,
  resolveSubagentChildAuthority,
} from "./subagent-child-owner-match.js";
import { resolveAnnounceDeliveryDeadline } from "./subagent-registry-cleanup.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  safeRemoveAttachmentsDir,
  shouldRemoveSubagentAttachments,
} from "./subagent-registry-helpers.js";
import type { CleanupBookkeepingParams } from "./subagent-registry-lifecycle-context.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import { isRetiredSubagentSessionOwner } from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

/** The stable reservation ID of a run's individual completion input. */
export const subagentCompletionSourceId = (entry: SubagentRunRecord) =>
  `subagent-completion:${entry.runId}:${entry.generation ?? 0}`;

/** Exact membership is required: sibling IDs and earlier yield generations are distinct inputs. */
function* subagentControllerInputs(entry: SubagentRunRecord) {
  const completionId = subagentCompletionSourceId(entry);
  const wake = entry.requesterSettleWake;
  const pause = entry.pauseReason === "sessions_yield" && Boolean(wake?.pauseNotice);
  const batchRunIds = (pause ? [entry.runId] : wake?.batchRunIds)?.filter((runId) => {
    const member = runId === entry.runId ? entry : subagentRuns.get(runId);
    return (
      member?.requesterSessionKey === entry.requesterSessionKey &&
      member.requesterAgentId === entry.requesterAgentId &&
      member.requesterStorePath === entry.requesterStorePath &&
      member.requesterSettleWake !== undefined &&
      member.requesterSettleWake.rearmGeneration === wake?.rearmGeneration
    );
  });
  const belongsToBatch = batchRunIds?.includes(entry.runId) === true;
  for (const mailbox of sessionControllerMailboxes()) {
    const target = mailbox.owner.target;
    if (
      !target ||
      !matchesSubagentChildSessionOwner(
        { childSessionKey: entry.requesterSessionKey, childAgentId: entry.requesterAgentId },
        mailbox.key,
        target.agentId,
      )
    ) {
      continue;
    }
    const batchIds = belongsToBatch
      ? [entry.requesterAgentId, target.agentId].map(
          (requesterAgentId) =>
            buildRequesterSettleWakeIdentity({
              requesterSessionKey: entry.requesterSessionKey,
              requesterAgentId,
              batchRunIds: batchRunIds!,
              rearmGeneration: wake?.rearmGeneration,
              pause,
            }).batchKey,
        )
      : [];
    for (const input of mailbox.entries.slice()) {
      const sourceTarget = input.target ?? target;
      if (
        (!entry.requesterStorePath ||
          (sourceTarget.physicalStorePath ?? sourceTarget.storeScope) ===
            entry.requesterStorePath) &&
        input.phase !== "consumed" &&
        (input.sourceTurnId === completionId ||
          (input.sourceTurnId !== undefined && batchIds.includes(input.sourceTurnId)))
      ) {
        yield input;
      }
    }
  }
}

export const hasSubagentControllerInput = (entry: SubagentRunRecord): boolean =>
  !subagentControllerInputs(entry).next().done;

/** Claimed turns revalidate at execution; retire only this obligation's unclaimed inputs. */
export function retireSubagentControllerInputs(entry: SubagentRunRecord): void {
  captureSubagentControllerInputRetirement(entry)();
}

/** Capture before settlement removes the frozen membership used to identify its reservations. */
export function captureSubagentControllerInputRetirement(entry: SubagentRunRecord): () => void {
  const inputs = [...subagentControllerInputs(entry)];
  return () => {
    for (const input of inputs) {
      if (!input.claim) {
        abortSessionControllerInput(input, new Error("Subagent obligation retired"));
      }
    }
  };
}

/** A terminal individual delivery releases its reservation, not the requester's owed cohort. */
export function retireSubagentCompletionControllerInput(entry: SubagentRunRecord): void {
  const completionId = subagentCompletionSourceId(entry);
  for (const input of subagentControllerInputs(entry)) {
    if (input.sourceTurnId === completionId && !input.claim) {
      abortSessionControllerInput(input, new Error("Subagent completion delivery settled"));
    }
  }
}

/** Only a resumable producer may retain its restored requester reservation. */
export function retainRestoredCompletionReservation(
  runs: Map<string, SubagentRunRecord>,
  snapshot: SubagentRunRecord,
  sessionEntry?: InternalSessionEntry,
) {
  const entry = getCurrentSubagentRunOwner(runs, snapshot);
  if (!entry || entry.runId !== snapshot.runId) {
    retireSubagentCompletionControllerInput(snapshot);
    return undefined;
  }
  const authority = resolveSubagentChildAuthority(entry, sessionEntry);
  const missingResult =
    entry.execution.status === "terminal" &&
    entry.execution.outcome === undefined &&
    entry.pauseReason !== "sessions_yield" &&
    entry.execution.lifecycleGeneration !== undefined &&
    !isAgentEventLifecycleGenerationCurrent(entry.execution.lifecycleGeneration);
  // Queued collectors retain their launch owner even before child session reconciliation.
  const orphanedSession =
    !(entry.collect && entry.execution.status === "queued") &&
    (sessionEntry?.abortedLastRun === true || isRetiredSubagentSessionOwner(entry, sessionEntry));
  if (
    authority.status === "mismatch" ||
    entry.execution.restartRecovery ||
    entry.killIntent ||
    entry.killReconciliation ||
    missingResult ||
    orphanedSession
  ) {
    retireSubagentCompletionControllerInput(entry);
    return undefined;
  }
  return { entry, authority };
}

/** Expired idle deliveries settle quietly; live producers and cohorts keep their custody. */
export async function settleSubagentCompletionReservation(
  entry: SubagentRunRecord,
  now: number,
  lifecycle: {
    completeCleanupBookkeeping: (params: CleanupBookkeepingParams) => Promise<void>;
    isCleanupOwnerCurrent: (entry: SubagentRunRecord) => boolean;
    isTerminalTailActive: (entry: SubagentRunRecord) => boolean;
    sessionEffectsHostCurrent: (entry: SubagentRunRecord) => boolean;
    shouldSuppressSessionEffects: (entry: SubagentRunRecord) => Promise<boolean>;
    discardTerminalDelivery: (entry: SubagentRunRecord, completedAt: number) => void;
    resumedRuns: Set<object>;
    clearPendingLifecycleError: (runId: string) => void;
    clearPendingLifecycleTimeout: (runId: string) => void;
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
    entry.execution.restartRecovery ||
    entry.killIntent ||
    entry.killReconciliation ||
    subagentRuns.isCompletionAuthorityRetired(entry) ||
    lifecycle.isTerminalTailActive(entry) ||
    hasLiveAgentRunContext(entry.runId) ||
    resolveAnnounceDeliveryDeadline(entry, now, ANNOUNCE_COMPLETION_HARD_EXPIRY_MS) > now
  ) {
    return false;
  }
  await lifecycle.completeCleanupBookkeeping({
    runId: entry.runId,
    entry,
    cleanup: entry.cleanup,
    completedAt: now,
    skipRequesterSettleWake: true,
    retainForCleanup: entry.cleanup === "delete",
    isCurrent: () => lifecycle.isCleanupOwnerCurrent(entry),
    finalizeDelivery: (draft) => {
      lifecycle.discardTerminalDelivery(draft, now);
      // The sweeper retains ownership of session and attachment deletion.
      if (draft.cleanup === "delete") {
        draft.archiveAtMs = now;
      }
    },
  });
  retireSubagentCompletionControllerInput(entry);
  if (
    entry.cleanup === "keep" &&
    shouldRemoveSubagentAttachments(entry) &&
    !(await lifecycle.shouldSuppressSessionEffects(entry))
  ) {
    await safeRemoveAttachmentsDir(
      entry,
      () => lifecycle.isCleanupOwnerCurrent(entry) && lifecycle.sessionEffectsHostCurrent(entry),
    );
  }
  lifecycle.resumedRuns.delete(getSubagentRunRuntimeKey(entry));
  lifecycle.clearPendingLifecycleError(entry.runId);
  lifecycle.clearPendingLifecycleTimeout(entry.runId);
  return true;
}
