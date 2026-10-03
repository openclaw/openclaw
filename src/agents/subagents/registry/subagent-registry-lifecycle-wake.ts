import { isDeepStrictEqual } from "node:util";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { isGatewayRestartDrainError } from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { revokeRequesterCronAuthorityBatch } from "../requester-cron-authority.js";
import { revokeRequesterFinalAttachment } from "../requester-final-attachment.js";
import { isCompletedRequesterDeliveryBlocked } from "./subagent-delivery-state.js";
import { retireSubagentGatewayBinding } from "./subagent-registry-execution-cleanup.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
  SubagentRegistryWriteError,
} from "./subagent-registry-persistence.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  hasRequesterWakeOwner,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import {
  commitRequesterSettleWakeMutation,
  isCurrentRequesterSettleWakeBatch,
} from "./subagent-registry-requester-wake-mutation.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { captureRequesterSettleRunIdentity } from "./subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
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
    !(await commitRequesterSettleWakeMutation(
      context,
      entries,
      outcome ? { kind: "settle", outcome } : { kind: "complete" },
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
        (isSameSubagentRunOwner(current, entry) ||
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
  observedEntries: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
  stateContext: OpenClawStateWorkerContext,
  settling?: PendingRequesterSettleWakeCommit,
): void {
  const params = context.options;
  const entries = observedEntries.map((entry) => {
    const current = params.runs.get(entry.runId);
    return current && isSameSubagentRunOwner(current, entry) ? current : entry;
  });
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
    if (
      retryTimer &&
      isSameSubagentRunOwner(retryTimer.entry, entry) &&
      retryTimer.rearmGeneration === rearmGeneration
    ) {
      clearTimeout(retryTimer.timer);
      context.scheduledRequesterSettleWakeTimers.delete(runId);
    }
    if (entry.requesterSettleWake === undefined || !params.runs.has(runId)) {
      if (
        context.pendingRequesterSettleWakeCommits.get(getSubagentRunRuntimeKey(entry)) !== settling
      ) {
        context.pendingRequesterSettleWakeCommits.delete(getSubagentRunRuntimeKey(entry));
      }
      retireSubagentGatewayBinding(entry);
      params.resumedRuns.delete(getSubagentRunRuntimeKey(entry));
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
  const key = getSubagentRunRuntimeKey(entry);
  context.cancelledRequesterSettleWakeRuns.add(key);
  try {
    await mutateSubagentRuns(
      [entry.runId],
      (rows) => {
        const current = rows.get(entry.runId);
        if (
          !isSameSubagentRunOwner(current, entry) ||
          !current ||
          current.execution.status !== "terminal" ||
          current.pauseReason === "sessions_yield" ||
          current.requesterSettleWake?.rearmGeneration !== wake.rearmGeneration ||
          !isDeepStrictEqual(current.requesterSettleWake?.batchRunIds, wake.batchRunIds)
        ) {
          throw new SubagentRegistryMutationRejectedError(
            "Subagent completion changed during cancellation; retry.",
          );
        }
        const next = structuredClone(current);
        next.suppressCompletionDelivery = true;
        next.requesterSettleWake = undefined;
        return { value: next, postimages: new Map([[next.runId, next]]) };
      },
      {
        runs: context.options.runs,
        context: workerContext,
        assertCurrent,
        onPublished: (_postimages, published) => {
          const requesterAgentId = resolveSubagentRequesterAgentId(
            context.options.getRuntimeConfig(),
            published,
          );
          if (requesterAgentId && wake.requesterYieldBatch && wake.rearmGeneration !== undefined) {
            revokeRequesterFinalAttachment({
              requesterAgentId,
              requesterSessionKey: published.requesterSessionKey,
              batchRunIds: wake.batchRunIds ?? [published.runId],
              rearmGeneration: wake.rearmGeneration,
            });
          }
          releaseRequesterSettleWakeBatch(
            context,
            [published],
            wake.rearmGeneration,
            workerContext,
          );
        },
      },
    );
  } catch (error) {
    if (!(error instanceof SubagentRegistryWriteError) || error.outcome === "not-committed") {
      context.cancelledRequesterSettleWakeRuns.delete(key);
      const current = context.options.runs.get(entry.runId);
      if (current && isSameSubagentRunOwner(current, entry)) {
        if (context.scheduledRequesterSettleWakeRuns.has(key)) {
          context.pendingRequesterSettleWakeRearms.add(key);
        } else {
          scheduleRequesterSettleWake(context, current.runId, current, workerContext);
        }
      }
    }
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
  if (
    isSameSubagentRunOwner(scheduled.entry, entry) &&
    !hasNewerGeneration &&
    deadline >= scheduled.deadline
  ) {
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
  observedEntry: SubagentRunRecord,
  originalContext?: OpenClawStateWorkerContext,
): void {
  const params = context.options;
  const publishedAtAdmission = params.runs.get(runId);
  if (publishedAtAdmission && !isSameSubagentRunOwner(publishedAtAdmission, observedEntry)) {
    return;
  }
  let entry =
    publishedAtAdmission && isSameSubagentRunOwner(publishedAtAdmission, observedEntry)
      ? publishedAtAdmission
      : observedEntry;
  if (context.cancelledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry))) {
    return;
  }
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
    context.scheduledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry))
  ) {
    return;
  }
  const scheduled = context.scheduledRequesterSettleWakeTimers.get(runId);
  const stateContext =
    pendingAtAdmission?.stateContext ??
    (scheduled && isSameSubagentRunOwner(scheduled.entry, entry)
      ? scheduled.stateContext
      : undefined) ??
    originalContext ??
    captureOpenClawStateWorkerContext();
  const admittedIdentity = captureRequesterSettleRunIdentity(entry);
  const isSourceCurrent = () => {
    try {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = params.runs.get(runId);
      if (current && isSameSubagentRunOwner(current, entry)) {
        entry = current;
      }
      return (
        !context.cancelledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry)) &&
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
  let admittedBatch = (
    entry.pauseReason === "sessions_yield" && admittedWake?.pauseNotice
      ? [runId]
      : (admittedWake?.batchRunIds ?? [runId])
  ).flatMap((id) => {
    const member = params.runs.get(id);
    return member ? [member] : [];
  });
  context.scheduledRequesterSettleWakeRuns.add(getSubagentRunRuntimeKey(entry));
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
              if (
                pending.needsWakeContinuation &&
                isSourceCurrent() &&
                pending.isCurrent(entry) &&
                entry.requesterSettleWake &&
                getPendingWakeCommit(context, entry) === undefined
              ) {
                pending.needsWakeContinuation = false;
                context.pendingRequesterSettleWakeRearms.add(getSubagentRunRuntimeKey(entry));
              }
              if (pending.initialTransfer?.completed) {
                context.pendingRequesterSettleWakeRearms.add(getSubagentRunRuntimeKey(entry));
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
              transitionBatch: async (batch, state, onPublished) => {
                const isCurrent = () =>
                  isSourceCurrent() &&
                  isCurrentRequesterSettleWakeBatch(context, batch, state.rearmGeneration);
                if (!isCurrent()) {
                  return;
                }
                const retainReplay =
                  state.nextAttemptAt !== undefined &&
                  batch.every((member) => {
                    const current = params.runs.get(member.runId);
                    return (
                      isSameSubagentRunOwner(current, member) &&
                      current?.requesterSettleWake?.status === "dispatching"
                    );
                  });
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
                      (acknowledged) => {
                        admittedBatch = [...acknowledged];
                        onPublished(acknowledged);
                      },
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
                    if (
                      Boolean(admittedWake?.pauseNotice) !==
                      Boolean(entry.requesterSettleWake?.pauseNotice)
                    ) {
                      return false;
                    }
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
              !isSameSubagentRunOwner(current, entry) ||
              current?.requesterSettleWake?.rearmGeneration !== admittedWake.rearmGeneration ||
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
        const current = params.runs.get(runId);
        if (current && isSameSubagentRunOwner(current, entry)) {
          entry = current;
        }
        context.unmarkRequesterSettleWakeRunScheduled(entry);
        const wasRearmedWhileRunning = context.pendingRequesterSettleWakeRearms.delete(
          getSubagentRunRuntimeKey(entry),
        );
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
