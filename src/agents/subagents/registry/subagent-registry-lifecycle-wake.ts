import { isDeepStrictEqual } from "node:util";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { revokeGoalContinuationReturn } from "../../../auto-reply/reply/goal-continuation-return.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { isGatewayRestartDrainError } from "../../../process/gateway-work-admission.js";
import { getCurrentSessionControllerOwner } from "../../../sessions/session-controller.context.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "../../../sessions/session-controller.identity.js";
import { getReplyOperationSessionReader } from "../../../sessions/session-controller.session-reader.js";
import { AgentDatabaseAdmissionError } from "../../../state/agent-database-admission.js";
import { waitForAgentDatabasePreparation } from "../../../state/agent-database-preparation-context.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { SubagentAnnouncePreparationConflictError } from "../announce/subagent-announce-result.js";
import { revokeRequesterCronAuthorityBatch } from "../requester-cron-authority.js";
import { revokeRequesterFinalAttachment } from "../requester-final-attachment.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import {
  captureSubagentControllerInputRetirement,
  retireSubagentControllerInputs,
} from "./subagent-controller-inputs.js";
import { isCompletedRequesterDeliveryBlocked } from "./subagent-delivery-state.js";
import { retireSubagentGatewayBinding } from "./subagent-registry-execution-cleanup.js";
import type {
  RequesterSettleWakeEvaluation,
  RequesterSettleWakeWait,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import { buildSafeLifecycleErrorMeta } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  assertSubagentRegistryWriteOutcomeKnown,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import {
  assertRequesterSettleWakeBatchCurrent,
  mutateRequesterSettleWakeBatch,
  settleRequesterSettleWakeBatch,
  isRetainedRequesterSettleWakeMember,
  type RequesterWakeMutationReceipt,
} from "./subagent-registry-requester-wake-mutation.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  captureRequesterSettleRunIdentity,
  isSubagentObligationRetired,
} from "./subagent-requester-settle-identity.js";
import { isClaimedByLiveRequesterTurn } from "./subagent-requester-turn-liveness.js";
import {
  currentSubagentRunOrObserved,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";
import { hasSubagentRunEnded } from "./subagent-run-liveness.js";

// Observed outcomes belong to the run owner, not the transient evaluation. Weak keys release
// retired owners; the scope keeps a later yield generation from consuming an older receipt.
const pendingRequesterSettlements = new WeakMap<
  object,
  {
    scope: string;
    rearmGeneration: number | undefined;
    receipt: RequesterWakeMutationReceipt;
    stateContext: OpenClawStateWorkerContext;
    settle: () => Promise<void>;
  }
>();
const pendingRequesterTransitions = new WeakMap<
  object,
  { scope: string; commit: () => Promise<void> }
>();

export function hasPendingRequesterSettlement(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
): boolean {
  const pending = pendingRequesterSettlements.get(getSubagentRunRuntimeKey(entry));
  if (!pending) {
    return false;
  }
  try {
    assertSubagentRegistryWriteSourceCurrent(pending.stateContext);
  } catch {
    return false;
  }
  return isRetainedRequesterSettleWakeMember(
    context,
    entry,
    pending.rearmGeneration,
    pending.receipt,
  );
}

/** Releases a settled batch's process-local custody, then re-evaluates the requester's other wakes. */
function releaseRequesterSettleWakeBatch(
  context: SubagentLifecycleWakeContext,
  observedEntries: readonly SubagentRunRecord[],
  rearmGeneration: number | undefined,
): void {
  const params = context.options;
  const entries = observedEntries.map((entry) => currentSubagentRunOrObserved(params.runs, entry));
  revokeRequesterCronAuthorityBatch(entries, rearmGeneration);
  const retiredEntries = entries.filter((entry) => !params.runs.has(entry.runId));
  for (const entry of retiredEntries) {
    subagentRuns.confirmRetirement(entry);
  }
  for (const entry of entries) {
    if (entry.requesterSettleWake === undefined || !params.runs.has(entry.runId)) {
      retireSubagentGatewayBinding(entry);
      clearRequesterSettleWait(context, requesterSettleWakeScope(entry));
      params.resumedRuns.delete(getSubagentRunRuntimeKey(entry));
      params.clearPendingLifecycleError(entry.runId);
    }
    // A provisional kill held by its cohort is confirmed once the cohort releases it.
    if (
      entry.requesterSettleWake === undefined &&
      entry.killReconciliation &&
      params.runs.has(entry.runId)
    ) {
      params.confirmProvisionalKill(entry);
    }
  }
  // Every member shares the requester; notify its siblings and ancestors once.
  if (entries[0]) {
    context.resumeAncestorCleanup(entries[0]);
  }
}

/**
 * Kill, suppression, and deletion retire a child's owed inputs. Unless its requester already
 * knows (the requester's own live turn retired it, or a requester-wide Stop or reset did), the
 * requester hears once: a yielded cohort keeps the retired member and its one continuation
 * reports it; any other row leaves its wave and its own completion reports it.
 */
export async function retireSubagentObligationsInContext(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  assertCurrent: () => void,
  options: { requesterNotified?: boolean } = {},
): Promise<void> {
  assertCurrent();
  retireSubagentControllerInputs(entry);
  if (!entry.requesterSettleWake) {
    return;
  }
  const requesterNotified =
    options.requesterNotified === true || isRetiredByLiveRequesterTurn(entry);
  const workerContext = captureOpenClawStateWorkerContext();
  await mutateSubagentRuns(
    [entry.runId],
    (rows) => {
      const current = rows.get(entry.runId);
      const wake = current?.requesterSettleWake;
      if (
        !current ||
        !isSameSubagentRunOwner(current, entry) ||
        !wake ||
        current.execution.status !== "terminal" ||
        current.pauseReason === "sessions_yield"
      ) {
        return { value: undefined };
      }
      const next = { ...current };
      const keepsCohort =
        !requesterNotified &&
        wake.requesterYieldBatch === true &&
        Boolean(wake.batchRunIds?.length);
      if (requesterNotified || keepsCohort) {
        next.suppressCompletionDelivery = true;
      }
      if (keepsCohort) {
        const { pauseNotice: _retiredNotice, ...cohortWake } = wake;
        next.requesterSettleWake = cohortWake;
      } else {
        next.requesterSettleWake = undefined;
      }
      return {
        value: { wake, keepsCohort, scope: requesterSettleWakeScope(current) },
        postimages: new Map([[next.runId, next]]),
      };
    },
    {
      runs: context.options.runs,
      context: workerContext,
      assertCurrent,
      onPublished: (postimages, retired) => {
        const published = postimages.get(entry.runId);
        if (!retired || !published) {
          return;
        }
        const { wake, keepsCohort, scope } = retired;
        if (keepsCohort) {
          // The cohort resolves now that this member has ended without a result.
          scheduleRequesterSettleWake(context, published.runId, published, workerContext);
          return;
        }
        clearRequesterSettleWait(context, scope);
        revokeGoalContinuationReturn(published);
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
        // Retiring a member re-evaluates its cohort; it can no longer hold the batch.
        releaseRequesterSettleWakeBatch(context, [published], wake.rearmGeneration);
      },
    },
  );
}

/** The requester's own running turn is the caller; it already knows what it stopped. */
function isRetiredByLiveRequesterTurn(entry: SubagentRunRecord): boolean {
  const caller = getCurrentSessionControllerOwner();
  if (!caller || caller.result || !isCurrentSessionControllerOperation(caller)) {
    return false;
  }
  const target = getSessionControllerEntryForOperation(caller).target;
  // A reused logical key is not proof that this physical requester heard the stop.
  // Unbound legacy rows keep their notification rather than borrowing a live store.
  return (
    target !== undefined &&
    entry.requesterStorePath ===
      (getReplyOperationSessionReader(caller)?.database.path ??
        target.physicalStorePath ??
        target.storeScope) &&
    matchesSubagentChildSessionOwner(
      { childSessionKey: entry.requesterSessionKey, childAgentId: entry.requesterAgentId },
      caller.key,
      caller.agentId,
    )
  );
}

function awaitsStoppedPauseRetirement(entry: SubagentRunRecord): boolean {
  return (
    entry.pauseReason !== "sessions_yield" &&
    entry.requesterSettleWake?.pauseNotice !== undefined &&
    isSubagentObligationRetired(entry)
  );
}

/** One in-flight evaluation per owed continuation; members of one cohort share it. */
function requesterSettleWakeScope(entry: SubagentRunRecord): string {
  const wake = entry.requesterSettleWake;
  const owner = `${entry.requesterStorePath ?? ""}\0${entry.requesterAgentId ?? ""}\0${entry.requesterSessionKey}`;
  if (entry.pauseReason === "sessions_yield" && wake?.pauseNotice) {
    return `${owner}\0pause\0${entry.runId}\0${wake.rearmGeneration ?? ""}`;
  }
  return `${owner}\0${wake?.batchRunIds?.toSorted().join(",") ?? ""}\0${wake?.rearmGeneration ?? ""}`;
}

function clearRequesterSettleWait(context: SubagentLifecycleWakeContext, scope: string): void {
  const waiting = context.waitingRequesterSettleWakes.get(scope);
  if (waiting?.timer) {
    clearTimeout(waiting.timer);
  }
  context.waitingRequesterSettleWakes.delete(scope);
}

/**
 * Evaluates the requester continuation this row owes. Only the requester's mailbox
 * decides when the continuation runs; this owner decides only whether it is owed.
 * A resume asks only that the row be evaluated; any other trigger reports changed state.
 */
export function scheduleRequesterSettleWake(
  context: SubagentLifecycleWakeContext,
  runId: string,
  observedEntry: SubagentRunRecord,
  originalContext?: OpenClawStateWorkerContext,
  resume = false,
): void {
  const params = context.options;
  const published = params.runs.get(runId);
  if (published && !isSameSubagentRunOwner(published, observedEntry)) {
    return;
  }
  let entry = published ?? observedEntry;
  const pendingSettlement = pendingRequesterSettlements.get(getSubagentRunRuntimeKey(entry));
  const admittedWake = entry.requesterSettleWake;
  // A committed settlement can remove the wake before its publication is acknowledged.
  const scope = admittedWake ? requesterSettleWakeScope(entry) : pendingSettlement?.scope;
  if (scope === undefined) {
    return;
  }
  for (const [waitingScope, waiting] of context.waitingRequesterSettleWakes) {
    if (waitingScope !== scope && isSameSubagentRunOwner(waiting.entry, entry)) {
      clearRequesterSettleWait(context, waitingScope);
    }
  }
  const pendingTransition = pendingRequesterTransitions.get(getSubagentRunRuntimeKey(entry));
  const pendingWait = context.waitingRequesterSettleWakes.get(scope);
  if (pendingWait) {
    if (
      !isSameSubagentRunOwner(params.runs.get(pendingWait.entry.runId), pendingWait.entry) ||
      !resume ||
      pendingSettlement?.scope === scope ||
      pendingTransition?.scope === scope
    ) {
      clearRequesterSettleWait(context, scope);
    } else {
      return;
    }
  }
  const requesterSessionKey = entry.requesterSessionKey?.trim();
  if (
    entry.collect ||
    !requesterSessionKey ||
    (isCompletedRequesterDeliveryBlocked(entry) && admittedWake?.requesterYieldBatch !== true) ||
    entry.execution.status === "running" ||
    !hasSubagentRunEnded(entry) ||
    awaitsStoppedPauseRetirement(entry) ||
    // A live requester turn transfers its own children when it ends.
    isClaimedByLiveRequesterTurn(entry)
  ) {
    return;
  }
  const active = context.activeRequesterSettleWakes.get(scope);
  if (
    active &&
    (isSameSubagentRunOwner(params.runs.get(active.entry.runId), active.entry) ||
      hasPendingRequesterSettlement(context, active.entry))
  ) {
    // The wake depends on sibling and descendant rows too, so a changed-state trigger reruns
    // the evaluation once. A resume is satisfied by one that has not yet read, or read this row.
    const satisfied =
      active.entry.runId === entry.runId &&
      (active.evaluated === undefined || (resume && active.evaluated === entry));
    if (!satisfied) {
      active.rearm = entry;
    }
    return;
  }
  const evaluation: RequesterSettleWakeEvaluation = { entry };
  let descendantWait: RequesterSettleWakeWait | undefined;
  context.activeRequesterSettleWakes.set(scope, evaluation);
  const stateContext = originalContext ?? captureOpenClawStateWorkerContext();
  const admittedIdentity = captureRequesterSettleRunIdentity(entry);
  const isSourceCurrent = () => {
    try {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      entry = currentSubagentRunOrObserved(params.runs, entry);
      assertSubagentRegistryWriteOutcomeKnown(
        admittedWake?.batchRunIds ?? [entry.runId],
        stateContext.admission,
      );
      // A committed deletion owns only its receipt acknowledgment, not another delivery.
      if (pendingSettlement?.scope === scope && pendingSettlement.receipt.committed) {
        return hasPendingRequesterSettlement(context, entry);
      }
      return (
        params.runs.get(entry.runId) === entry &&
        isDeepStrictEqual(captureRequesterSettleRunIdentity(entry), admittedIdentity)
      );
    } catch {
      return false;
    }
  };
  const admittedBatch = (
    entry.pauseReason === "sessions_yield" && admittedWake?.pauseNotice
      ? [runId]
      : (admittedWake?.batchRunIds ?? [runId])
  ).flatMap((id) => {
    const member = params.runs.get(id);
    return member ? [member] : [];
  });
  let settleObserved = pendingSettlement?.scope === scope ? pendingSettlement.settle : undefined;
  let publishDispatch = pendingTransition?.scope === scope ? pendingTransition.commit : undefined;
  const completeBatch = async (
    batch: readonly SubagentRunRecord[],
    rearmGeneration: number | undefined,
    outcome?: Parameters<typeof settleRequesterSettleWakeBatch>[3],
    onCommitted?: () => void | Promise<void>,
  ) => {
    // A retirement may have replaced the pause notice this evaluation was delivering.
    entry = currentSubagentRunOrObserved(params.runs, entry);
    if (Boolean(admittedWake?.pauseNotice) !== Boolean(entry.requesterSettleWake?.pauseNotice)) {
      return;
    }
    // Retry bookkeeping with the observed outcome, never by replaying delivery or inventing failure.
    const receipt: RequesterWakeMutationReceipt = {};
    const retireInputs = batch.map(captureSubagentControllerInputRetirement);
    const settlement = {
      scope,
      rearmGeneration,
      receipt,
      stateContext,
      settle: async (): Promise<void> => {
        const members = batch.filter(
          (member) =>
            pendingRequesterSettlements.get(getSubagentRunRuntimeKey(member)) === settlement &&
            isRetainedRequesterSettleWakeMember(context, member, rearmGeneration, receipt),
        );
        // A quiet decision needs its whole cohort; a recorded outcome stays with surviving peers.
        const settlesMembers =
          members.length > 0 &&
          (outcome !== undefined ||
            receipt.committed !== undefined ||
            members.length === batch.length);
        if (
          settlesMembers &&
          !(await settleRequesterSettleWakeBatch(
            context,
            members,
            rearmGeneration,
            outcome,
            stateContext,
            receipt,
          ))
        ) {
          return;
        }
        for (const member of batch) {
          const key = getSubagentRunRuntimeKey(member);
          if (pendingRequesterSettlements.get(key) === settlement) {
            pendingRequesterSettlements.delete(key);
          }
        }
        if (settlesMembers) {
          for (const retire of retireInputs) {
            retire();
          }
          await onCommitted?.();
          releaseRequesterSettleWakeBatch(context, members, rearmGeneration);
        }
      },
    };
    for (const member of batch) {
      pendingRequesterSettlements.set(getSubagentRunRuntimeKey(member), settlement);
    }
    settleObserved = settlement.settle;
    await settleObserved();
  };
  runWithoutOwnedSessionTranscriptWrites(() => {
    void context
      .runRequesterSettleWake(
        entry,
        async (releasePreparation) => {
          // Admission can wait; reread the row before a blocked receipt is executed again.
          if (
            !isSourceCurrent() ||
            awaitsStoppedPauseRetirement(entry) ||
            (isCompletedRequesterDeliveryBlocked(entry) &&
              entry.requesterSettleWake?.requesterYieldBatch !== true)
          ) {
            return;
          }
          try {
            if (settleObserved) {
              await settleObserved();
              return;
            }
            if (!admittedWake) {
              return;
            }
            if (publishDispatch) {
              await publishDispatch();
            }
            for (let preparationAttempt = 0; ; preparationAttempt++) {
              evaluation.evaluated = entry;
              const observedBatch = admittedBatch.map((member) => params.runs.get(member.runId));
              try {
                await params.maybeWakeRequesterAfterAllChildrenSettled({
                  requesterSessionKey,
                  requesterOrigin: entry.requesterOrigin,
                  settledEntry: entry,
                  isSourceCurrent,
                  onAccepted: releasePreparation,
                  onDescendantsPending: (deadline) => {
                    if (isSourceCurrent()) {
                      descendantWait = { entry, deadline };
                    }
                  },
                  transitionBatch: async (batch, state, onPublished) => {
                    // New transitions need the whole batch; retained receipts may reconcile survivors.
                    if (!isSourceCurrent()) {
                      return;
                    }
                    try {
                      assertRequesterSettleWakeBatchCurrent(
                        context,
                        batch,
                        state.rearmGeneration,
                        false,
                      );
                    } catch {
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
                    const receipt: RequesterWakeMutationReceipt = {};
                    const transition = {
                      scope,
                      commit: async () => {
                        let retainOnFailure = false;
                        try {
                          const members = batch.filter(
                            (member) =>
                              pendingRequesterTransitions.get(getSubagentRunRuntimeKey(member)) ===
                                transition &&
                              isRetainedRequesterSettleWakeMember(
                                context,
                                member,
                                state.rearmGeneration,
                                receipt,
                              ),
                          );
                          if (members.length === 0) {
                            return;
                          }
                          const committed = await mutateRequesterSettleWakeBatch(
                            context,
                            members,
                            state.rearmGeneration,
                            { kind: "transition", state },
                            stateContext,
                            receipt,
                            onPublished,
                          );
                          if (!committed) {
                            throw new Error("Requester dispatch awaits its current publication");
                          }
                        } catch (error) {
                          retainOnFailure =
                            retainReplay ||
                            receipt.committed !== undefined ||
                            hasSqliteWorkerOutcomeUnknown(error);
                          throw error;
                        } finally {
                          if (!retainOnFailure) {
                            for (const member of batch) {
                              const key = getSubagentRunRuntimeKey(member);
                              if (pendingRequesterTransitions.get(key) === transition) {
                                pendingRequesterTransitions.delete(key);
                              }
                            }
                            publishDispatch = undefined;
                          }
                        }
                      },
                    };
                    for (const member of batch) {
                      pendingRequesterTransitions.set(getSubagentRunRuntimeKey(member), transition);
                    }
                    publishDispatch = transition.commit;
                    await publishDispatch();
                  },
                  completeBatch,
                });
                break;
              } catch (error: unknown) {
                // Refresh changed results once in this evaluation. Persistent conflicts wait
                // for a new lifecycle event instead of creating an unbounded rearm chain.
                if (
                  preparationAttempt === 0 &&
                  !settleObserved &&
                  error instanceof SubagentAnnouncePreparationConflictError &&
                  isSourceCurrent() &&
                  admittedBatch.some(
                    (member, index) => params.runs.get(member.runId) !== observedBatch[index],
                  )
                ) {
                  continue;
                }
                throw error;
              }
            }
          } catch (error: unknown) {
            if (isGatewayRestartDrainError(error)) {
              return;
            }
            if (publishDispatch) {
              // No Gateway effect started; a lifecycle trigger reconciles this exact receipt.
              params.warn("failed to publish requester settle dispatch", {
                error: buildSafeLifecycleErrorMeta(error),
                runId,
              });
              return;
            }
            const retryPreparation =
              !settleObserved &&
              ((error instanceof AgentDatabaseAdmissionError &&
                error.refusal.code === "agent-database-inspection-pending") ||
                error instanceof SubagentAnnouncePreparationConflictError ||
                (error instanceof WorkerTaskError && error.code === "overloaded"));
            const safeError = buildSafeLifecycleErrorMeta(error);
            if (retryPreparation) {
              // No delivery was admitted. Retain the exact cohort and its counters;
              // readiness belongs to the preparation owner, never a lifecycle retry timer.
              if (!isSourceCurrent()) {
                return;
              }
              const ready =
                error instanceof AgentDatabaseAdmissionError
                  ? waitForAgentDatabasePreparation(error.refusal.agentId)
                  : error instanceof WorkerTaskError
                    ? error.capacityAvailable
                    : undefined;
              if (ready) {
                const continueWake = () => {
                  if (isSourceCurrent()) {
                    scheduleRequesterSettleWake(context, entry.runId, entry, stateContext);
                  }
                };
                // The preparation owner owns this wait; do not keep a Gateway root open.
                // Failure re-enters too: a final admission refusal records the terminal outcome.
                void ready.then(continueWake, continueWake).catch((resumeError: unknown) => {
                  params.warn("requester settle wake readiness continuation failed", {
                    error: buildSafeLifecycleErrorMeta(resumeError),
                    runId,
                  });
                });
              } else {
                params.warn(
                  "requester settle wake preparation deferred until its next lifecycle event",
                  {
                    error: safeError,
                    runId,
                  },
                );
              }
              return;
            }
            params.warn("requester settle wake failed", {
              error: safeError,
              runId,
              requesterSessionKey,
            });
            if (!isSourceCurrent()) {
              return;
            }
            // Delivery may have succeeded before its bookkeeping failed. Preserve that result.
            const settle =
              settleObserved ??
              (() =>
                completeBatch(admittedBatch, admittedWake?.rearmGeneration, {
                  delivered: false,
                  path: "none",
                  error: safeError.message,
                }));
            await settle().catch((settleError: unknown) => {
              params.warn("failed to persist requester settle wake rejection", {
                error: buildSafeLifecycleErrorMeta(settleError),
                runId,
              });
            });
          }
        },
        isSourceCurrent,
      )
      .catch((error: unknown) => {
        if (!isGatewayRestartDrainError(error)) {
          params.warn("requester settle wake admission failed", {
            error: buildSafeLifecycleErrorMeta(error),
            runId,
          });
        }
      })
      .finally(() => {
        if (context.activeRequesterSettleWakes.get(scope) !== evaluation) {
          return;
        }
        context.activeRequesterSettleWakes.delete(scope);
        const rearm = evaluation.rearm;
        if (rearm) {
          scheduleRequesterSettleWake(context, rearm.runId, rearm, stateContext);
        } else if (descendantWait && isSourceCurrent()) {
          // Active descendants wake us by lifecycle event. Only terminal delivery has
          // a bounded grace deadline, derived from durable end times by the reader.
          const waiting = descendantWait;
          context.waitingRequesterSettleWakes.set(scope, waiting);
          if (waiting.deadline !== undefined) {
            waiting.timer = setTimeout(
              () => {
                if (context.waitingRequesterSettleWakes.get(scope) !== waiting) {
                  return;
                }
                clearRequesterSettleWait(context, scope);
                if (isSourceCurrent()) {
                  scheduleRequesterSettleWake(context, entry.runId, entry, stateContext);
                }
              },
              Math.max(0, waiting.deadline - Date.now()),
            );
            waiting.timer.unref();
          }
        }
      });
  });
}
