import { isDeepStrictEqual } from "node:util";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { clearGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { settleRequesterCompletionBatch } from "../completion/subagent-completion-admission.store.js";
import { revokeRequesterCronAuthorityBatch } from "../requester-cron-authority.js";
import { revokeRequesterFinalAttachment } from "../requester-final-attachment.js";
import {
  isCompletedRequesterDeliveryBlocked,
  markRequesterSettleWakePending,
} from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type {
  CleanupBookkeepingParams,
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  hasRequesterWakeOwner,
  rearmRequesterWakeAfterCommit,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import {
  assertRequesterWakeCommitCurrent,
  commitRequesterSettleWakeMutation,
  isCurrentRequesterSettleWakeBatch,
} from "./subagent-registry-requester-wake-mutation.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { captureRequesterSettleRunIdentity } from "./subagent-requester-settle-identity.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

const completeRequesterSettleWakeBatch = async (
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  stateContext: OpenClawStateWorkerContext,
  pending: PendingRequesterSettleWakeCommit,
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
): Promise<boolean> => {
  const params = context.options;
  if (
    !pending.committedWake &&
    !isCurrentRequesterSettleWakeBatch(
      context,
      entries,
      rearmGeneration,
      outcome?.delivered === true && outcome.requesterVisibleFinalDelivered === true,
    )
  ) {
    return false;
  }
  assertSubagentRegistryWriteSourceCurrent(stateContext);
  if (outcome) {
    const result = await settleRequesterCompletionBatch({
      entries: entries.map((subagent) => ({ subagent })),
      outcome,
      context: stateContext,
      committed: pending.committedWake,
      onCommitted: (write) => {
        pending.committedWake = write;
      },
      onPublished: () => pending.adoptPublished(entries),
      retiredPreimages: new Set(entries.filter((entry) => pending.isPublishedRetirement(entry))),
      isCurrent: () => {
        assertRequesterWakeCommitCurrent(
          context,
          entries,
          stateContext,
          pending,
          outcome.delivered && outcome.requesterVisibleFinalDelivered === true,
        );
        return true;
      },
    });
    if (result.applied !== true || result.publication !== "published") {
      return false;
    }
  } else if (
    !(await commitRequesterSettleWakeMutation(
      context,
      entries,
      { kind: "complete" },
      stateContext,
      pending,
    ))
  ) {
    return false;
  }
  assertSubagentRegistryWriteSourceCurrent(stateContext);
  // The durable receipt survives caller retirement; release only its remaining owned rows.
  releaseRequesterSettleWakeBatch(
    context,
    entries.filter((entry) => {
      const current = params.runs.get(entry.runId);
      return (
        (current === entry ||
          (current === undefined && !context.newerGenerationOwnsSession(entry))) &&
        getPendingWakeCommit(context, entry) === pending
      );
    }),
    rearmGeneration,
    stateContext,
    pending,
  );
  return true;
};

function releaseRequesterSettleWakeBatch(
  context: SubagentLifecycleWakeContext,
  entries: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
  stateContext: OpenClawStateWorkerContext,
  settling?: PendingRequesterSettleWakeCommit,
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
    const retryTimer = context.scheduledRequesterSettleWakeTimers.get(runId);
    if (retryTimer?.entry === entry && retryTimer.rearmGeneration === rearmGeneration) {
      clearTimeout(retryTimer.timer);
      context.scheduledRequesterSettleWakeTimers.delete(runId);
    }
    if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
      if (context.pendingRequesterSettleWakeCommits.get(entry) !== settling) {
        context.pendingRequesterSettleWakeCommits.delete(entry);
      }
      clearGatewayContextResolver(entry);
      params.resumedRuns.delete(runId);
      params.clearPendingLifecycleError(runId);
    }
  }
  for (const [runId, entry] of params.runs) {
    if (entry.requesterSettleWake && requesterSessionKeys.has(entry.requesterSessionKey)) {
      scheduleRequesterSettleWake(context, runId, entry, stateContext);
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
        releaseRequesterSettleWakeBatch(context, [entry], wake.rearmGeneration, workerContext);
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
      if (context.scheduledRequesterSettleWakeRuns.has(entry)) {
        context.pendingRequesterSettleWakeRearms.add(entry);
      } else {
        scheduleRequesterSettleWake(context, entry.runId, entry, workerContext);
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
  const scheduled = context.scheduledRequesterSettleWakeTimers.get(entry.runId);
  if (!scheduled) {
    return false;
  }
  const rearmGeneration =
    getPendingWakeCommit(context, entry)?.generation ?? entry.requesterSettleWake?.rearmGeneration;
  const hasNewerGeneration =
    rearmGeneration !== undefined &&
    (scheduled.rearmGeneration === undefined || rearmGeneration > scheduled.rearmGeneration);
  if (scheduled.entry === entry && !hasNewerGeneration && deadline >= scheduled.deadline) {
    return true;
  }
  clearTimeout(scheduled.timer);
  context.scheduledRequesterSettleWakeTimers.delete(entry.runId);
  return false;
}

function scheduleRequesterSettleWakeRetry(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
  stateContext: OpenClawStateWorkerContext,
): void {
  const pending = getPendingWakeCommit(context, entry);
  const nextAttemptAt = pending?.nextAttemptAt ?? entry.requesterSettleWake?.nextAttemptAt;
  if (
    pending?.initialTransfer?.blocked ||
    nextAttemptAt === undefined ||
    nextAttemptAt <= Date.now()
  ) {
    return;
  }
  const rearmGeneration = pending?.generation ?? entry.requesterSettleWake?.rearmGeneration;
  if (retainScheduledRequesterSettleWakeTimer(context, entry, nextAttemptAt)) {
    return;
  }
  const timer = setTimeout(
    () => {
      if (context.scheduledRequesterSettleWakeTimers.get(runId)?.timer !== timer) {
        return;
      }
      context.scheduledRequesterSettleWakeTimers.delete(runId);
      if (
        hasRequesterWakeOwner(context, entry) &&
        (entry.requesterSettleWake || getPendingWakeCommit(context, entry))
      ) {
        scheduleRequesterSettleWake(context, runId, entry, stateContext);
      }
    },
    Math.max(0, nextAttemptAt - Date.now()),
  );
  timer.unref?.();
  context.scheduledRequesterSettleWakeTimers.set(runId, {
    entry,
    timer,
    deadline: nextAttemptAt,
    rearmGeneration,
    stateContext,
  });
}

export function scheduleRequesterSettleWake(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
  originalContext?: OpenClawStateWorkerContext,
): void {
  const params = context.options;
  const pendingAtAdmission = getPendingWakeCommit(context, entry);
  const admittedWake = entry.requesterSettleWake;
  const requesterSessionKey = entry.requesterSessionKey?.trim();
  if (
    pendingAtAdmission?.initialTransfer?.blocked ||
    (!admittedWake && !pendingAtAdmission) ||
    entry.collect ||
    (!pendingAtAdmission &&
      isCompletedRequesterDeliveryBlocked(entry) &&
      admittedWake?.requesterYieldBatch !== true) ||
    (!pendingAtAdmission?.initialTransfer &&
      (entry.execution.status === "running" || !hasSubagentRunEnded(entry))) ||
    !requesterSessionKey ||
    (!pendingAtAdmission?.initialTransfer &&
      entry.requesterTurnRunId &&
      entry.expectsCompletionMessage === true) ||
    context.scheduledRequesterSettleWakeRuns.has(entry)
  ) {
    return;
  }
  const scheduled = context.scheduledRequesterSettleWakeTimers.get(runId);
  const stateContext =
    pendingAtAdmission?.stateContext ??
    (scheduled?.entry === entry ? scheduled.stateContext : undefined) ??
    originalContext ??
    captureOpenClawStateWorkerContext();
  const admittedIdentity = captureRequesterSettleRunIdentity(entry);
  const isSourceCurrent = () => {
    try {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      return (
        isDeepStrictEqual(captureRequesterSettleRunIdentity(entry), admittedIdentity) &&
        hasRequesterWakeOwner(context, entry)
      );
    } catch {
      return false;
    }
  };
  const now = Date.now();
  const nextAttemptAt = pendingAtAdmission?.nextAttemptAt ?? admittedWake?.nextAttemptAt;
  const deadline = nextAttemptAt !== undefined && nextAttemptAt > now ? nextAttemptAt : now;
  if (retainScheduledRequesterSettleWakeTimer(context, entry, deadline)) {
    return;
  }
  if (nextAttemptAt !== undefined && nextAttemptAt > now) {
    scheduleRequesterSettleWakeRetry(context, runId, entry, stateContext);
    return;
  }
  const admittedBatch = (admittedWake?.batchRunIds ?? [runId]).flatMap((id) => {
    const member = params.runs.get(id);
    return member ? [member] : [];
  });
  context.scheduledRequesterSettleWakeRuns.add(entry);
  runWithoutOwnedSessionTranscriptWrites(() => {
    void context
      .runRequesterSettleWake(
        entry,
        async () => {
          try {
            if (!isSourceCurrent()) {
              return;
            }
            const pending = getPendingWakeCommit(context, entry);
            if (pending) {
              await retryPendingWakeCommit(context, pending);
              rearmRequesterWakeAfterCommit(context, pending, entry, isSourceCurrent);
              if (pending.initialTransfer?.completed) {
                context.pendingRequesterSettleWakeRearms.add(entry);
              }
              return;
            }
            if (
              isCompletedRequesterDeliveryBlocked(entry) &&
              entry.requesterSettleWake?.requesterYieldBatch !== true
            ) {
              return;
            }
            await params.maybeWakeRequesterAfterAllChildrenSettled({
              requesterSessionKey,
              requesterOrigin: entry.requesterOrigin,
              settledEntry: entry,
              isSourceCurrent,
              transitionBatch: async (batch, state) => {
                const isCurrent = () =>
                  isSourceCurrent() &&
                  isCurrentRequesterSettleWakeBatch(context, batch, state.rearmGeneration);
                if (!isCurrent()) {
                  return;
                }
                const retainReplay =
                  state.nextAttemptAt !== undefined &&
                  batch.every((member) => member.requesterSettleWake?.status === "dispatching");
                let published = false;
                await commitRequesterWake(
                  context,
                  batch,
                  state.rearmGeneration,
                  async (members, episode) => {
                    const retrying = episode.failures > 0;
                    const committed = await commitRequesterSettleWakeMutation(
                      context,
                      members,
                      { kind: "transition", state },
                      stateContext,
                      episode,
                    );
                    if (committed) {
                      published = true;
                      // The retrying member claims continuation after this shared episode
                      // clears, including when a sibling now owns the execution slot.
                      if (retrying) {
                        episode.needsWakeContinuation = true;
                      }
                    }
                    return committed;
                  },
                  (error, episode) =>
                    retainReplay ||
                    episode.committedWake !== undefined ||
                    hasSqliteWorkerOutcomeUnknown(error),
                  false,
                  stateContext,
                );
                if (!published && isCurrent()) {
                  throw new Error("Requester wake transition awaits current publication");
                }
              },
              completeBatch: (batch, rearmGeneration, outcome, onCommitted) =>
                commitRequesterWake(
                  context,
                  batch,
                  rearmGeneration,
                  async (members, episode) => {
                    const committed = await completeRequesterSettleWakeBatch(
                      context,
                      members,
                      stateContext,
                      episode,
                      rearmGeneration,
                      outcome,
                    );
                    if (committed) {
                      onCommitted?.();
                    }
                    return committed;
                  },
                  true,
                  outcome === undefined,
                  stateContext,
                ),
            });
          } catch (error: unknown) {
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
              current.requesterSettleWake !== admittedWake ||
              !isSourceCurrent()
            ) {
              return;
            }
            try {
              await commitRequesterWake(
                context,
                admittedBatch,
                admittedWake.rearmGeneration,
                (members, episode) =>
                  completeRequesterSettleWakeBatch(
                    context,
                    members,
                    stateContext,
                    episode,
                    admittedWake.rearmGeneration,
                    {
                      delivered: false,
                      path: "none",
                      error: safeError.message,
                    },
                  ),
                true,
                false,
                stateContext,
              );
            } catch (settleError) {
              params.warn("failed to persist requester settle wake rejection", {
                error: buildSafeLifecycleErrorMeta(settleError),
                runId: maskLifecycleIdentifier(runId, "run"),
              });
            }
          }
        },
        isSourceCurrent,
      )
      .catch((error: unknown) => {
        if (!isGatewayRestartDrainError(error)) {
          params.warn("requester settle wake admission failed", {
            error: buildSafeLifecycleErrorMeta(error),
            runId: maskLifecycleIdentifier(runId, "run"),
          });
        }
      })
      .finally(() => {
        context.unmarkRequesterSettleWakeRunScheduled(entry);
        const wasRearmedWhileRunning = context.pendingRequesterSettleWakeRearms.delete(entry);
        if (
          hasRequesterWakeOwner(context, entry) &&
          (entry.requesterSettleWake || getPendingWakeCommit(context, entry))
        ) {
          if (wasRearmedWhileRunning) {
            scheduleRequesterSettleWake(context, runId, entry, stateContext);
          } else {
            scheduleRequesterSettleWakeRetry(context, runId, entry, stateContext);
          }
        }
      });
  });
}

export function completeCleanupBookkeeping(
  context: SubagentLifecycleWakeContext,
  cleanupParams: CleanupBookkeepingParams,
): void {
  const stateContext = cleanupParams.stateContext ?? captureOpenClawStateWorkerContext();
  const params = context.options;
  // Bookkeeping can retire the row; detached child effects refresh currency below.
  const suppressSessionEffects = !context.sessionEffectsHostCurrent(cleanupParams.entry);
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
        context.sessionEffectsHostCurrent(cleanupParams.entry)
      );
    };
    const runCleanupTail = (label: string, run: () => Promise<unknown>) => {
      // Admission can outlive the caller's async scope. Own the tail's lifetime
      // and recheck row ownership after waiting; surviving tails still block snapshots.
      void runWithGatewayDetachedWorkAdmission(async () => {
        if (
          !(await context.shouldSuppressSessionEffects(cleanupParams.entry)) &&
          postBookkeepingEffectsAllowed()
        ) {
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
          {
            isCurrent: postBookkeepingEffectsAllowed,
            prepareCurrent: async () =>
              !(await context.shouldSuppressSessionEffects(cleanupParams.entry)) &&
              postBookkeepingEffectsAllowed(),
          },
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
    scheduleRequesterSettleWake(context, cleanupParams.runId, cleanupParams.entry, stateContext);
  }
}
