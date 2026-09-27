import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import {
  clearGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { settleRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { revokeRequesterCronAuthorityBatch } from "../requester-cron-authority.js";
import { revokeRequesterFinalAttachment } from "../requester-final-attachment.js";
import { isCompletedRequesterDeliveryBlocked } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type {
  CleanupBookkeepingParams,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  markRequesterSettleWakePending,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

type RequesterSettleWakeBatchState =
  import("../announce/subagent-announce.requester-settle-wake.js").RequesterSettleWakeBatchState;

const isCurrentRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  batch: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  visibleFinalDelivered = false,
): boolean => {
  // Closure can precede replacement activation. Only a recorded visible final
  // may settle then; cancellation or an in-flight handoff must retain the wake.
  try {
    return (
      batch.length > 0 &&
      (visibleFinalDelivered ||
        batch.every((entry) => {
          const resolve = getGatewayContextResolver(entry);
          return !resolve || Boolean(resolve());
        })) &&
      // Validate every row and generation after calling the captured owner fences.
      batch.every(
        (entry) =>
          context.options.runs.get(entry.runId) === entry &&
          entry.requesterSettleWake &&
          entry.requesterSettleWake.rearmGeneration === rearmGeneration,
      )
    );
  } catch {
    return false;
  }
};

const transitionRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
) => {
  const params = context.options;
  if (!isCurrentRequesterSettleWakeBatch(context, entries, state.rearmGeneration)) {
    return false;
  }
  const previousStates = entries.map((entry) => entry.requesterSettleWake);
  for (const entry of entries) {
    entry.requesterSettleWake = {
      ...state,
      ...(entry.requesterSettleWake?.progressOperationId
        ? { progressOperationId: entry.requesterSettleWake.progressOperationId }
        : {}),
      ...(entry.requesterSettleWake?.retireAfterSettle === true ? { retireAfterSettle: true } : {}),
    };
  }
  try {
    params.persistOrThrow(...entries.map((entry) => entry.runId));
  } catch (error) {
    entries.forEach((entry, index) => {
      entry.requesterSettleWake = previousStates[index];
    });
    throw error;
  }
  return true;
};

const completeRequesterSettleWakeBatch = (
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
) => {
  const params = context.options;
  if (
    !isCurrentRequesterSettleWakeBatch(
      context,
      entries,
      rearmGeneration,
      outcome?.delivered === true && outcome.requesterVisibleFinalDelivered === true,
    )
  ) {
    return false;
  }
  if (outcome) {
    settleRequesterCompletionBatch({
      entries: entries.map((subagent) => {
        const resolution = params.resolveSubagentTask(subagent);
        if (resolution.lookup !== "available") {
          throw new Error(
            "subagent completion owner unavailable before settlement: " + subagent.runId,
          );
        }
        return { subagent, taskId: resolution.task?.taskId };
      }),
      outcome,
      isCurrent: () =>
        isCurrentRequesterSettleWakeBatch(
          context,
          entries,
          rearmGeneration,
          outcome.delivered && outcome.requesterVisibleFinalDelivered === true,
        ),
    });
  } else {
    const previousStates = entries.map((entry) => ({
      requesterSettleWake: entry.requesterSettleWake,
      retireAfterRequesterTurn: entry.retireAfterRequesterTurn,
    }));
    for (const entry of entries) {
      if (entry.pauseReason !== "sessions_yield") {
        if (entry.requesterTurnRunId && entry.expectsCompletionMessage === true) {
          entry.retireAfterRequesterTurn =
            entry.retireAfterRequesterTurn === true ||
            entry.requesterSettleWake?.retireAfterSettle === true
              ? true
              : undefined;
        } else if (entry.requesterSettleWake?.retireAfterSettle === true) {
          params.runs.delete(entry.runId);
        }
      }
      entry.requesterSettleWake = undefined;
    }
    try {
      params.persistOrThrow(...entries.map((entry) => entry.runId));
    } catch (error) {
      entries.forEach((entry, index) => {
        params.runs.set(entry.runId, entry);
        Object.assign(entry, previousStates[index]);
      });
      throw error;
    }
  }
  releaseRequesterSettleWakeBatch(context, entries, rearmGeneration);
  return true;
};

function releaseRequesterSettleWakeBatch(
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  rearmGeneration?: number,
): void {
  const params = context.options;
  const requesterSessionKeys = new Set(entries.map((entry) => entry.requesterSessionKey));
  revokeRequesterCronAuthorityBatch(entries, rearmGeneration);
  const retiredEntries: SubagentRunRecord[] = [];
  for (const entry of entries) {
    const { runId } = entry;
    if (!params.runs.has(runId)) {
      subagentRuns.confirmRetirement(entry);
      retiredEntries.push(entry);
    }
  }
  for (const entry of entries) {
    const { runId } = entry;
    const retryTimer = context.getRequesterSettleWakeTimer(runId);
    if (retryTimer?.entry === entry && retryTimer.rearmGeneration === rearmGeneration) {
      clearTimeout(retryTimer.timer);
      context.deleteRequesterSettleWakeTimer(runId);
    }
    if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
      context.pendingRequesterSettleWakeCommits.delete(entry);
      clearGatewayContextResolver(entry);
      params.resumedRuns.delete(runId);
      params.clearPendingLifecycleError(runId);
    }
  }
  for (const [runId, entry] of params.runs) {
    if (entry.requesterSettleWake && requesterSessionKeys.has(entry.requesterSessionKey)) {
      scheduleRequesterSettleWake(context, runId, entry);
    }
  }
  for (const entry of retiredEntries) {
    if (!params.runs.has(entry.runId)) {
      context.resumeAncestorCleanup(entry);
    }
  }
}

/** Stop retires a completed child's continuation without changing its captured outcome. */
export async function cancelRequesterSettleWake(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  assertCurrent: () => void,
): Promise<void> {
  const wake = entry.requesterSettleWake;
  if (!wake || entry.execution.status !== "terminal" || entry.pauseReason === "sessions_yield") {
    return;
  }
  assertCurrent();
  const workerContext = captureOpenClawStateWorkerContext();
  const suppressed = entry.suppressCompletionDelivery;
  const pendingCommit = getPendingWakeCommit(context, entry);
  // Fence an in-flight dispatch before yielding to the writer. A refused write
  // restores the original obligation; an uncertain commit must remain fenced.
  entry.suppressCompletionDelivery = true;
  entry.requesterSettleWake = undefined;
  const ownsCancellation = () =>
    context.options.runs.get(entry.runId) === entry &&
    entry.requesterSettleWake === undefined &&
    entry.suppressCompletionDelivery === true;
  try {
    await persistSubagentRunsToDiskAsyncOrThrow(context.options.runs, [entry.runId], {
      context: workerContext,
      assertCurrent: () => {
        assertCurrent();
        if (!ownsCancellation()) {
          throw new Error("Subagent completion changed during cancellation; retry.");
        }
      },
      onCommitted: () => {
        // A replacement can commit while the worker acknowledgement is in flight.
        // Only the exact cancelled row may release its continuation resources.
        if (!ownsCancellation()) {
          return;
        }
        const requesterAgentId = resolveSubagentRequesterAgentId(
          context.options.getRuntimeConfig(),
          entry,
        );
        if (requesterAgentId && wake.requesterYieldBatch && wake.rearmGeneration !== undefined) {
          revokeRequesterFinalAttachment({
            requesterAgentId,
            requesterSessionKey: entry.requesterSessionKey,
            batchRunIds: wake.batchRunIds ?? [entry.runId],
            rearmGeneration: wake.rearmGeneration,
          });
        }
        releaseRequesterSettleWakeBatch(context, [entry], wake.rearmGeneration);
      },
    });
  } catch (error) {
    if (
      error instanceof SubagentRegistryWriteError &&
      error.outcome === "not-committed" &&
      ownsCancellation()
    ) {
      entry.suppressCompletionDelivery = suppressed;
      entry.requesterSettleWake = wake;
      // A sibling retry can discard this temporarily fenced member while the
      // write waits. Restore its observed outcome before any transport resumes.
      if (pendingCommit?.isCurrent(entry)) {
        context.pendingRequesterSettleWakeCommits.set(entry, pendingCommit);
      }
      if (context.hasScheduledRequesterSettleWakeRun(entry)) {
        context.markRequesterSettleWakeRearm(entry);
      } else {
        scheduleRequesterSettleWake(context, entry.runId, entry);
      }
    }
    throw error;
  }
}

function persistCleanupBookkeeping(
  context: SubagentLifecycleWakeContext,
  cleanup: CleanupBookkeepingParams,
  suppressSessionEffects: boolean,
  retireAfterSettle: boolean,
): void {
  const { entry } = cleanup;
  const previous = {
    cleanupCompletedAt: entry.cleanupCompletedAt,
    execution: entry.execution,
    terminalOwner: entry.terminalOwner,
    ...(entry.collect || !cleanup.skipRequesterSettleWake
      ? { requesterSettleWake: entry.requesterSettleWake }
      : {}),
  };
  entry.cleanupCompletedAt = cleanup.completedAt;
  if (suppressSessionEffects) {
    entry.execution = {
      ...entry.execution,
      restartRecovery: undefined,
      suppressSessionEffects: true,
    };
    entry.terminalOwner = undefined;
  }
  if (entry.collect) {
    entry.requesterSettleWake = undefined;
  } else if (!cleanup.skipRequesterSettleWake) {
    markRequesterSettleWakePending(entry, { retireAfterSettle });
  }
  try {
    context.options.persistOrThrow(cleanup.runId);
  } catch (error) {
    Object.assign(entry, previous);
    throw error;
  }
}

// Once a child reaches a terminal settle, let the announce layer decide
// whether its requester's batch has fully drained and, if so, wake the
// registry-less top-level requester to synthesize. Settle bookkeeping never
// blocks on the wake, but the wake must run as tracked root work: a live
// cleanup parent reserves the root synchronously, so restart or suspend
// cannot reach quiescence between scheduling and the wake's gateway turn.
// Terminal failures settle only the exact wake so a newer requester-yield rearm survives.
function retainScheduledRequesterSettleWakeTimer(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  deadline: number,
): boolean {
  const scheduled = context.getRequesterSettleWakeTimer(entry.runId);
  if (!scheduled) {
    return false;
  }
  const rearmGeneration = entry.requesterSettleWake?.rearmGeneration;
  const hasNewerGeneration =
    rearmGeneration !== undefined &&
    (scheduled.rearmGeneration === undefined || rearmGeneration > scheduled.rearmGeneration);
  // A restored owner must not inherit a timer whose callback still captures the old row.
  if (scheduled.entry === entry && !hasNewerGeneration && deadline >= scheduled.deadline) {
    return true;
  }
  clearTimeout(scheduled.timer);
  context.deleteRequesterSettleWakeTimer(entry.runId);
  return false;
}

function scheduleRequesterSettleWakeRetry(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
): void {
  const params = context.options;
  const nextAttemptAt =
    getPendingWakeCommit(context, entry)?.nextAttemptAt ?? entry.requesterSettleWake?.nextAttemptAt;
  if (nextAttemptAt === undefined || nextAttemptAt <= Date.now()) {
    return;
  }
  const rearmGeneration = entry.requesterSettleWake?.rearmGeneration;
  if (retainScheduledRequesterSettleWakeTimer(context, entry, nextAttemptAt)) {
    return;
  }
  const timer = setTimeout(
    () => {
      if (context.getRequesterSettleWakeTimer(runId)?.timer !== timer) {
        return;
      }
      context.deleteRequesterSettleWakeTimer(runId);
      const current = params.runs.get(runId);
      if (current === entry && current.requesterSettleWake) {
        scheduleRequesterSettleWake(context, runId, current);
      }
    },
    Math.max(0, nextAttemptAt - Date.now()),
  );
  timer.unref?.();
  context.setRequesterSettleWakeTimer(runId, {
    entry,
    timer,
    deadline: nextAttemptAt,
    rearmGeneration,
  });
}

export function scheduleRequesterSettleWake(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
): void {
  const params = context.options;
  const admittedWake = entry.requesterSettleWake;
  const requesterSessionKey = entry.requesterSessionKey?.trim();
  // A replayed lifecycle start can retain an older endedAt; require both
  // terminal status and end evidence so a live child never wakes its requester.
  if (
    !admittedWake ||
    entry.collect ||
    // Also fences older persisted ordinary wakes on restart. Explicit retry
    // clears suspension; a genuine yielded batch keeps its existing owner.
    (isCompletedRequesterDeliveryBlocked(entry) && admittedWake?.requesterYieldBatch !== true) ||
    entry.execution.status === "running" ||
    !hasSubagentRunEnded(entry) ||
    !requesterSessionKey ||
    (entry.requesterTurnRunId && entry.expectsCompletionMessage === true) ||
    context.hasScheduledRequesterSettleWakeRun(entry)
  ) {
    return;
  }
  const now = Date.now();
  const nextAttemptAt =
    getPendingWakeCommit(context, entry)?.nextAttemptAt ?? entry.requesterSettleWake?.nextAttemptAt;
  const deadline = nextAttemptAt !== undefined && nextAttemptAt > now ? nextAttemptAt : now;
  if (retainScheduledRequesterSettleWakeTimer(context, entry, deadline)) {
    return;
  }
  if (nextAttemptAt !== undefined && nextAttemptAt > now) {
    scheduleRequesterSettleWakeRetry(context, runId, entry);
    return;
  }
  const admittedBatch = (admittedWake?.batchRunIds ?? [runId]).flatMap((id) => {
    const member = params.runs.get(id);
    return member ? [member] : [];
  });
  context.markRequesterSettleWakeRunScheduled(entry);
  // Wake turns outlive their spawning attempt; clear its owner before both
  // dispatch and chained re-arms so transcript writes acquire a fresh lock.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void context
      .runRequesterSettleWake(entry, async () => {
        // Admission may wait behind restored work. Revalidate the durable block
        // after that wait, not only when the wake was initially scheduled.
        if (
          isCompletedRequesterDeliveryBlocked(entry) &&
          entry.requesterSettleWake?.requesterYieldBatch !== true
        ) {
          return false;
        }
        const pending = getPendingWakeCommit(context, entry);
        if (pending) {
          retryPendingWakeCommit(context, pending);
          return false;
        }
        return params.maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey,
          requesterOrigin: entry.requesterOrigin,
          settledEntry: entry,
          transitionBatch: (batch, state) =>
            commitRequesterWake(
              context,
              batch,
              state.rearmGeneration,
              (members) => transitionRequesterSettleWakeBatch(context, members, state),
              state.nextAttemptAt !== undefined &&
                batch.every((member) => member.requesterSettleWake?.status === "dispatching"),
            ),
          completeBatch: (batch, rearmGeneration, outcome, onCommitted) =>
            commitRequesterWake(
              context,
              batch,
              rearmGeneration,
              (members) => {
                const committed = completeRequesterSettleWakeBatch(
                  context,
                  members,
                  rearmGeneration,
                  outcome,
                );
                if (committed) {
                  onCommitted?.();
                }
                return committed;
              },
              true,
            ),
        });
      })
      .catch((error: unknown) => {
        // Restart admission defers the durable wake to startup; it is not a delivery failure.
        if (isGatewayRestartDrainError(error)) {
          return;
        }
        const safeError = buildSafeLifecycleErrorMeta(error);
        if (shouldReportRequesterSettleWakeFailure(context, entry, safeError)) {
          params.warn("requester settle wake failed", {
            error: safeError,
            runId: maskLifecycleIdentifier(runId, "run"),
            requesterSessionKey: maskLifecycleIdentifier(requesterSessionKey, "session"),
          });
        }
        const current = params.runs.get(runId);
        if (
          getPendingWakeCommit(context, entry) ||
          !admittedWake ||
          current !== entry ||
          current.requesterSettleWake !== admittedWake
        ) {
          return;
        }
        try {
          commitRequesterWake(
            context,
            admittedBatch,
            admittedWake.rearmGeneration,
            (members) =>
              completeRequesterSettleWakeBatch(context, members, admittedWake.rearmGeneration, {
                delivered: false,
                path: "none",
                error: safeError.message,
              }),
            true,
          );
        } catch (settleError) {
          params.warn("failed to persist requester settle wake rejection", {
            error: buildSafeLifecycleErrorMeta(settleError),
            runId: maskLifecycleIdentifier(runId, "run"),
            requesterSessionKey: maskLifecycleIdentifier(requesterSessionKey, "session"),
          });
        }
      })
      .finally(() => {
        context.unmarkRequesterSettleWakeRunScheduled(entry);
        const wasRearmedWhileRunning = context.takeRequesterSettleWakeRearm(entry);
        const current = params.runs.get(runId);
        if (current === entry && current.requesterSettleWake) {
          if (wasRearmedWhileRunning) {
            // A requester yield can freeze a delivered batch while this run is
            // resolving its earlier no-wake decision. Admit that durable update now.
            scheduleRequesterSettleWake(context, runId, current);
          } else {
            scheduleRequesterSettleWakeRetry(context, runId, current);
          }
        }
      });
  });
}

export function completeCleanupBookkeeping(
  context: SubagentLifecycleWakeContext,
  cleanupParams: CleanupBookkeepingParams,
): void {
  const params = context.options;
  const suppressSessionEffects = context.shouldSuppressSessionEffects(cleanupParams.entry);
  const scheduleCleanupTails = (options: {
    allowRetiredRow: boolean;
    isDeleteCleanup: boolean;
  }) => {
    // Retained bookkeeping requires the exact row. Immediate retirement
    // removes it first, so absence remains ownership only while no newer
    // child generation exists; any replacement blocks the stale cleanup.
    const postBookkeepingEffectsAllowed = () => {
      const current = params.runs.get(cleanupParams.runId);
      const rowOwnershipMatches =
        current === cleanupParams.entry || (options.allowRetiredRow && current === undefined);
      return (
        rowOwnershipMatches &&
        !context.newerGenerationOwnsSession(cleanupParams.entry) &&
        !context.shouldSuppressSessionEffects(cleanupParams.entry)
      );
    };
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // Admission can outlive the caller's async scope. Own the tail's lifetime
      // and recheck row ownership after waiting; surviving tails still block snapshots.
      void runWithGatewayDetachedWorkAdmission(async () => {
        if (postBookkeepingEffectsAllowed()) {
          await run();
        }
      }, "subagents:lifecycle-cleanup").catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] subagent ${label} failed (${cleanupParams.runId}): ${String(error)}`,
        );
      });
    };
    if (postBookkeepingEffectsAllowed() && !cleanupParams.preserveTranscript) {
      runCleanupTail("session cleanup", () =>
        removeInternalSessionEffectsSession(cleanupParams.entry.execution.transcriptTarget),
      );
    }
    if (postBookkeepingEffectsAllowed() && cleanupParams.entry.spawnMode !== "session") {
      runCleanupTail("bundle MCP cleanup", () =>
        retireSessionMcpRuntimeForSessionKey({
          sessionKey: cleanupParams.entry.childSessionKey,
          reason: "subagent-run-cleanup",
          preserveActiveLeases: true,
          onError: (error, sessionId) => {
            params.warn("failed to retire subagent bundle MCP runtime", {
              error: buildSafeLifecycleErrorMeta(error),
              sessionId,
              runId: maskLifecycleIdentifier(cleanupParams.runId, "run"),
              childSessionKey: maskLifecycleIdentifier(
                cleanupParams.entry.childSessionKey,
                "session",
              ),
            });
          },
        }),
      );
    }
    if (
      !cleanupParams.provisionalKill &&
      postBookkeepingEffectsAllowed() &&
      (options.isDeleteCleanup || !cleanupParams.entry.collect)
    ) {
      runCleanupTail("context-engine cleanup", () =>
        params.notifyContextEngineSubagentEnded(
          {
            childSessionKey: cleanupParams.entry.childSessionKey,
            reason: options.isDeleteCleanup ? "deleted" : "completed",
            agentDir: cleanupParams.entry.agentDir,
            workspaceDir: cleanupParams.entry.workspaceDir,
          },
          { isCurrent: postBookkeepingEffectsAllowed },
        ),
      );
    }
  };
  if (cleanupParams.provisionalKill) {
    // The provider result or bounded kill reconciliation owns terminal settle.
    // Its kill marker was committed by the caller before reaching this tail.
    scheduleCleanupTails({ allowRetiredRow: false, isDeleteCleanup: false });
    return;
  }
  const isDeleteCleanup = cleanupParams.cleanup === "delete";
  if (isDeleteCleanup) {
    params.clearPendingLifecycleError(cleanupParams.runId);
  }
  const retireAfterSettle =
    !cleanupParams.entry.collect &&
    (isDeleteCleanup ||
      (cleanupParams.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
        cleanupParams.entry.suppressAnnounceReason !== "killed"));
  // Reconciled keep-mode kills retire the registry row, not the child session.
  if (retireAfterSettle && !isDeleteCleanup) {
    params.clearPendingLifecycleError(cleanupParams.runId);
  }
  if (retireAfterSettle && cleanupParams.skipRequesterSettleWake) {
    params.runs.delete(cleanupParams.runId);
    try {
      params.persistOrThrow(cleanupParams.runId);
    } catch (error) {
      params.runs.set(cleanupParams.runId, cleanupParams.entry);
      throw error;
    }
    subagentRuns.confirmRetirement(cleanupParams.entry);
    clearGatewayContextResolver(cleanupParams.entry);
  } else {
    // Collector tombstones and announcing runs share the same durable cleanup
    // boundary; only announcing runs keep a requester-settle obligation.
    persistCleanupBookkeeping(context, cleanupParams, suppressSessionEffects, retireAfterSettle);
    if (cleanupParams.entry.collect || cleanupParams.skipRequesterSettleWake) {
      clearGatewayContextResolver(cleanupParams.entry);
    }
  }
  // A settle wake may retire its durably marked row before detached tails start.
  // A replacement row or newer child generation still fences these effects.
  scheduleCleanupTails({ allowRetiredRow: retireAfterSettle, isDeleteCleanup });
  context.resumeAncestorCleanup(cleanupParams.entry);
  if (!cleanupParams.entry.collect && !cleanupParams.skipRequesterSettleWake) {
    scheduleRequesterSettleWake(context, cleanupParams.runId, cleanupParams.entry);
  }
}
