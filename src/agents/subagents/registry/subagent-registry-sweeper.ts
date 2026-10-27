import type { callGateway } from "../../../gateway/call.js";
import {
  getGatewayRestartDrainSignal,
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { runInDetachedAsyncContext } from "../../../shared/detached-async-context.js";
import {
  blockSubagentCompletionDelivery,
  reconcileRetiredSubagentCancellation,
} from "../completion/subagent-completion-admission.store.js";
import { settleSubagentCompletionReservation } from "./subagent-controller-inputs.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import {
  PROVISIONAL_KILL_RECONCILIATION_MS,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import {
  getRecordedSubagentChildAuthority,
  getSubagentSweepRuns,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import {
  discardSuspendedPendingFinalDelivery,
  isSuspendedPendingFinalDelivery,
  SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS,
  warnSuspendedDeliveryPressure,
} from "./subagent-registry-suspended-delivery.js";
import {
  createSubagentSweepReadScope,
  deleteSweptSession,
  mutateCleanup,
  freezeSessionIdentity,
  sweptContext,
  isSessionCleanupDeferred,
  isCollectorArchiveReady,
  isCleanupCurrent,
  type FrozenSessionIdentity,
} from "./subagent-registry-sweep-cleanup.js";
import {
  reconcileDurableSubagentKillIntent,
  reconcileProvisionalSubagentKill,
} from "./subagent-registry-sweep-kill.js";
import { orderSubagentSweepEntries } from "./subagent-registry-sweep-order.js";
import { settleUnreachableYieldedSubagentRun } from "./subagent-registry-sweep-settle.js";
import { SUBAGENT_SESSION_RUN_TTL_MS } from "./subagent-registry-work-index.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isYieldedSubagentRun } from "./subagent-run-liveness.js";
import { shouldSuppressSubagentSessionEffects } from "./subagent-session-effects-policy.js";
export { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";

type CompletionRuntime = ReturnType<typeof createSubagentRegistryCompletionRuntime>;

export function createSubagentRegistrySweeper(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<object>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: CompletionRuntime["completeSubagentRunWithRecovery"];
  startSubagentAnnounceCleanupFlow: SubagentLifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  resumeRequesterSettleWake: SubagentLifecycleController["resumeRequesterSettleWake"];
  resumePendingRequesterSettlements: SubagentLifecycleController["resumePendingRequesterSettlements"];
  isCleanupOwnerCurrent: SubagentLifecycleController["isCleanupOwnerCurrent"];
  isTerminalTailActive: SubagentLifecycleController["isTerminalTailActive"];
  sessionEffectsHostCurrent: SubagentLifecycleController["sessionEffectsHostCurrent"];
  shouldSuppressSessionEffects: SubagentLifecycleController["shouldSuppressSessionEffects"];
  discardTerminalDelivery: typeof SubagentLifecycleController.discardTerminalDelivery;
  shouldEmitEndedHookForRun: SubagentLifecycleOptions["shouldEmitEndedHookForRun"];
  emitSubagentEndedHookForRun: SubagentLifecycleOptions["emitSubagentEndedHookForRun"];
  callGateway: typeof callGateway;
  cleanupCollectorLaunchResources: (entry: SubagentRunRecord) => Promise<boolean>;
  runContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  notifyContextEngineSubagentEnded: (params: ContextEngineSubagentEndedParams) => Promise<void>;
  retireSupersededRun: (runId: string, entry: SubagentRunRecord) => Promise<void>;
  retireObligations: (entry: SubagentRunRecord) => Promise<void>;
  getRunsForChildSession: (
    childSessionKey: string,
    childAgentId?: string,
  ) => Iterable<SubagentRunRecord>;
  getRunsForCollectorGroup: (
    requesterSessionKey: string,
    groupId: string,
    requesterAgentId?: string,
  ) => Iterable<[string, SubagentRunRecord]>;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}) {
  const { runs } = params;
  let intervalStarted = false;
  let scheduled: { timer: NodeJS.Timeout; at: number } | undefined;
  let sweepInProgress = false;
  let rerunRequested = false;
  let lastWarnedSuspendedCount: number | undefined;
  const pendingWork = new Set<Promise<unknown>>();

  function trackWork<T>(run: () => Promise<T>): Promise<T> {
    const pending = run();
    pendingWork.add(pending);
    const settled = () => pendingWork.delete(pending);
    void pending.then(settled, settled);
    return pending;
  }

  function start() {
    if (!intervalStarted) {
      intervalStarted = true;
      schedule({ delayMs: 60_000 });
    }
  }

  function stop() {
    intervalStarted = false;
    clearTimeout(scheduled?.timer);
    scheduled = undefined;
    rerunRequested = false;
  }

  function stopIfIdle() {
    const pendingRequesterSettlements = params.resumePendingRequesterSettlements();
    if (runs.size === 0 && !pendingRequesterSettlements) {
      stop();
    }
  }

  function schedule(options?: { delayMs?: number }) {
    const delayMs = Math.max(0, options?.delayMs ?? 5_000);
    const nextAt = Date.now() + delayMs;
    if (scheduled && scheduled.at <= nextAt) {
      return;
    }
    clearTimeout(scheduled?.timer);
    const timer = runInDetachedAsyncContext(() =>
      setTimeout(() => {
        scheduled = undefined;
        void trackWork(runTick);
      }, delayMs),
    );
    timer.unref();
    scheduled = { timer, at: nextAt };
  }

  async function runTick() {
    if (sweepInProgress) {
      rerunRequested = true;
      return;
    }
    try {
      await runWithGatewayDetachedWorkAdmission(() => sweepOnce(), "subagents:sweeper");
    } catch (error) {
      if (isGatewayRestartDrainError(error)) {
        return params.warn("subagent run sweep skipped: gateway is draining for restart");
      }
      params.warn(
        `subagent run sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (rerunRequested) {
      rerunRequested = false;
      schedule({ delayMs: 0 });
    } else if (intervalStarted) {
      schedule({ delayMs: 60_000 });
    }
  }

  function runCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
    // Cleanup can outlive the tick as well as the request that armed its timer.
    void trackWork(() =>
      runWithGatewayDetachedWorkAdmission(run, "subagents:sweeper-cleanup").catch(
        (error: unknown) => params.warn(`subagent sweep ${label} failed`, { runId, error }),
      ),
    );
  }

  async function sweepOnce() {
    if (sweepInProgress) {
      return;
    }
    sweepInProgress = true;
    const drainSignal = getGatewayRestartDrainSignal();
    try {
      const now = Date.now();
      const runEntries = orderSubagentSweepEntries(runs, now);
      if (runEntries.length === 0) {
        params.sweepPendingLifecycle(now);
        stopIfIdle();
        return;
      }
      const readScope = createSubagentSweepReadScope(runs);
      const deleteSession = (entry: SubagentRunRecord, identity: FrozenSessionIdentity) =>
        deleteSweptSession(
          entry,
          identity,
          runs,
          params.callGateway,
          () => readScope.assertRunCurrent(entry),
          readScope.gatewayResolver,
        );
      const collectorArchiveCandidates = new Map<
        string,
        { requesterSessionKey: string; groupId: string; requesterAgentId?: string }
      >();
      // Completion stays fresh across awaits, but deletion must retain the earlier
      // CAS identity. Bind it to the exact run so replacements wait for another pass.
      const cleanupIdentities = new Map<object, FrozenSessionIdentity | undefined>();
      for (const [, entry] of runEntries) {
        if (
          getRecordedSubagentChildAuthority(entry).status === "mismatch" ||
          typeof entry.execution.endedAt !== "number" ||
          (entry.requesterSettleWake && !subagentRuns.isCompletionAuthorityRetired(entry)) ||
          isSuspendedPendingFinalDelivery(entry) ||
          ((entry.killIntent || entry.killReconciliation) &&
            !subagentRuns.isCompletionAuthorityRetired(entry)) ||
          !(entry.collect && entry.collectorCompletion
            ? entry.collectorLaunchCleanupPending || isCollectorArchiveReady(entry, now)
            : entry.archiveAtMs && entry.archiveAtMs <= now && !isSessionCleanupDeferred(entry))
        ) {
          continue;
        }
        // Suppressed session cleanup still requires the captured member for artifact cleanup.
        cleanupIdentities.set(
          getSubagentRunRuntimeKey(entry),
          shouldSuppressSubagentSessionEffects(entry) ? undefined : freezeSessionIdentity(entry),
        );
      }
      for (const [runId, snapshot] of runEntries) {
        // Finish admitted cleanup, but leave the remaining durable backlog for the next Gateway.
        if (drainSignal.aborted) {
          return;
        }
        readScope.assertCurrent();
        const selected = runs.get(runId);
        if (!selected || !isSameSubagentRunOwner(selected, snapshot)) {
          continue;
        }
        if (await settleSubagentCompletionReservation(selected, now, params)) {
          continue;
        }
        if (
          (selected.delivery?.status === "pending" ||
            selected.delivery?.status === "in_progress") &&
          subagentRuns.isCompletionAuthorityRetired(selected)
        ) {
          await blockSubagentCompletionDelivery({
            subagent: selected,
            reason: "store replaced",
            suspendedReason: "permanent_failure",
            storeReplaced: true,
          });
          continue;
        }
        if (
          selected.killReconciliation &&
          (await reconcileRetiredSubagentCancellation(selected, now)) === false
        ) {
          continue;
        }
        const reconciled = runs.get(runId);
        if (!reconciled || !isSameSubagentRunOwner(reconciled, selected)) {
          continue;
        }
        let entry = reconciled;
        // A yielded run no continuation can reach settles instead of parking forever.
        const executionRetired = subagentRuns.isCompletionAuthorityRetired(entry);
        if (
          !executionRetired &&
          isYieldedSubagentRun(entry) &&
          (await settleUnreachableYieldedSubagentRun({
            runId,
            entry,
            readScope,
            complete: params.completeSubagentRunWithRecovery,
          }))
        ) {
          continue;
        }
        // Retry live receipts even when the last child has already settled.
        // The lifecycle and controller still own evaluation and turn admission.
        if (
          !executionRetired &&
          entry.requesterSettleWake &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry)
        ) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (isSuspendedPendingFinalDelivery(entry)) {
          const expired =
            now - (entry.delivery?.suspendedAt ?? now) >= SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS;
          if (expired) {
            await discardSuspendedPendingFinalDelivery({
              ...params,
              runId,
              entry,
              now,
              isCurrent: () => params.isCleanupOwnerCurrent(entry),
            });
          }
          continue;
        }
        if (!executionRetired && entry.killIntent) {
          await reconcileDurableSubagentKillIntent({
            ...params,
            runId,
            entry,
          });
          continue;
        }
        if (!executionRetired && entry.killReconciliation) {
          // Live operation settlement confirms kills immediately; this is the dormant fallback.
          if (entry.killReconciliation.killedAt + PROVISIONAL_KILL_RECONCILIATION_MS <= now) {
            await reconcileProvisionalSubagentKill({
              ...params,
              runId,
              entry,
              now,
            });
          }
          continue;
        }
        if (typeof entry.execution.endedAt !== "number") {
          // A row without a live execution is retained history, not a restart obligation.
          continue;
        }

        if (entry.collect && entry.collectorCompletion) {
          if (entry.collectorLaunchCleanupPending) {
            let suppressSessionEffects = shouldSuppressSubagentSessionEffects(entry);
            if (!suppressSessionEffects) {
              if (!cleanupIdentities.has(getSubagentRunRuntimeKey(entry))) {
                continue;
              }
              const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(entry));
              if (!sessionIdentity) {
                continue;
              } else {
                try {
                  suppressSessionEffects =
                    (await deleteSession(entry, sessionIdentity)) === "changed";
                  if (!isCleanupCurrent(runs.get(runId), entry)) {
                    continue;
                  }
                  if (!suppressSessionEffects) {
                    if (
                      !(await params.cleanupCollectorLaunchResources(entry)) ||
                      !isCleanupCurrent(runs.get(runId), entry)
                    ) {
                      continue;
                    }
                    emitSessionLifecycleEvent({
                      sessionKey: entry.childSessionKey,
                      reason: "delete",
                      parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
                    });
                  }
                } catch (error) {
                  params.warn("failed to retry collector launch cleanup", {
                    runId,
                    childSessionKey: entry.childSessionKey,
                    error,
                  });
                  continue;
                }
              }
            }
            const updated = await mutateCleanup(
              runs,
              entry,
              (current) =>
                current.collect === true &&
                current.collectorCompletion !== undefined &&
                current.collectorLaunchCleanupPending === true,
              (draft) => {
                if (suppressSessionEffects) {
                  draft.execution.suppressSessionEffects = true;
                }
                draft.collectorLaunchCleanupPending = false;
                draft.cleanupCompletedAt = now;
              },
            );
            if (!updated) {
              continue;
            }
            entry = updated;
          }
          const groupId = entry.groupId?.trim();
          const requesterSessionKey = entry.swarmRequesterSessionKey ?? entry.requesterSessionKey;
          if (groupId) {
            collectorArchiveCandidates.set(
              JSON.stringify([entry.requesterAgentId, requesterSessionKey, groupId]),
              { requesterSessionKey, groupId, requesterAgentId: entry.requesterAgentId },
            );
          }
          continue;
        }
        if (
          isSessionCleanupDeferred(entry) ||
          (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session")
        ) {
          continue;
        }
        if (!entry.archiveAtMs) {
          const deleted = await mutateCleanup(
            runs,
            entry,
            (current) =>
              !current.archiveAtMs &&
              typeof current.cleanupCompletedAt === "number" &&
              now - current.cleanupCompletedAt > SUBAGENT_SESSION_RUN_TTL_MS,
            () => null,
          );
          if (deleted === null) {
            params.clearPendingLifecycleError(runId);
            if (!shouldSuppressSubagentSessionEffects(entry)) {
              runCleanupTail(runId, "context-engine cleanup", () =>
                params.notifyContextEngineSubagentEnded(sweptContext(entry)),
              );
            }
            if (!entry.retainAttachmentsOnKeep) {
              await safeRemoveAttachmentsDir(entry);
            }
          }
          continue;
        }
        if (entry.archiveAtMs > now) {
          continue;
        }
        const suppressSessionEffects = shouldSuppressSubagentSessionEffects(entry);
        let sessionOwnershipChanged = false;
        if (!suppressSessionEffects) {
          if (!cleanupIdentities.has(getSubagentRunRuntimeKey(entry))) {
            continue;
          }
          const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(entry));
          if (!sessionIdentity) {
            continue;
          }
          try {
            sessionOwnershipChanged = (await deleteSession(entry, sessionIdentity)) === "changed";
          } catch (error) {
            params.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
              runId,
              childSessionKey: entry.childSessionKey,
              error,
            });
            continue;
          }
        }
        const deleted = await mutateCleanup(
          runs,
          entry,
          (current) =>
            current.archiveAtMs !== undefined &&
            current.archiveAtMs <= now &&
            !(current.collect && current.collectorCompletion),
          () => null,
        );
        if (deleted !== null) {
          continue;
        }
        params.clearPendingLifecycleError(runId);
        await safeRemoveAttachmentsDir(entry);
        if (!suppressSessionEffects && !sessionOwnershipChanged) {
          runCleanupTail(runId, "context-engine cleanup", () =>
            params.notifyContextEngineSubagentEnded(sweptContext(entry)),
          );
        }
      }
      collectorGroups: for (const {
        requesterSessionKey,
        groupId,
        requesterAgentId,
      } of collectorArchiveCandidates.values()) {
        const readGroup = () => [
          ...params.getRunsForCollectorGroup(requesterSessionKey, groupId, requesterAgentId),
        ];
        const groupEntries = readGroup();
        if (
          groupEntries.some(
            ([, candidate]) =>
              getRecordedSubagentChildAuthority(candidate).status === "mismatch" ||
              !isCollectorArchiveReady(candidate, now) ||
              !cleanupIdentities.has(getSubagentRunRuntimeKey(candidate)) ||
              (!shouldSuppressSubagentSessionEffects(candidate) &&
                !cleanupIdentities.get(getSubagentRunRuntimeKey(candidate))) ||
              !isCleanupCurrent(candidate, candidate),
          )
        ) {
          continue;
        }
        for (const [candidateRunId, candidate] of groupEntries) {
          if (drainSignal.aborted) {
            return;
          }
          const warnCleanup = (message: string, failure?: { error: unknown }) =>
            params.warn(message, {
              runId: candidateRunId,
              childSessionKey: candidate.childSessionKey,
              groupId,
              ...failure,
            });
          let current = runs.get(candidateRunId);
          if (!isCleanupCurrent(current, candidate) || !isCollectorArchiveReady(current, now)) {
            continue collectorGroups;
          }
          if (!shouldSuppressSubagentSessionEffects(current)) {
            const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(candidate));
            try {
              const changed =
                !sessionIdentity || (await deleteSession(current, sessionIdentity)) === "changed";
              if (changed) {
                const updated = await mutateCleanup(
                  runs,
                  current,
                  (row) => isCollectorArchiveReady(row, now),
                  (draft) => {
                    draft.execution.suppressSessionEffects = true;
                  },
                );
                if (!updated) {
                  continue collectorGroups;
                }
                current = updated;
              }
            } catch (error) {
              warnCleanup("sessions.delete failed during collector group sweep; keeping group", {
                error,
              });
              continue collectorGroups;
            }
          }
          if (!isCleanupCurrent(runs.get(candidateRunId), candidate)) {
            continue collectorGroups;
          }
          if (!(await safeRemoveAttachmentsDir(current))) {
            warnCleanup("attachment cleanup failed during collector group sweep; keeping group");
            continue collectorGroups;
          }
          if (
            current.cleanup !== "delete" &&
            !shouldSuppressSubagentSessionEffects(current) &&
            typeof current.contextEngineCleanupCompletedAt !== "number"
          ) {
            try {
              await params.runContextEngineSubagentEnded(sweptContext(current));
              if (
                !(await mutateCleanup(
                  runs,
                  current,
                  (row) => isCollectorArchiveReady(row, now),
                  (draft) => {
                    draft.contextEngineCleanupCompletedAt = Date.now();
                  },
                ))
              ) {
                continue collectorGroups;
              }
            } catch (error) {
              warnCleanup(
                "context-engine cleanup failed during collector group sweep; keeping group",
                { error },
              );
              continue collectorGroups;
            }
          }
        }
        const deleted = await mutateSubagentRuns(
          groupEntries.map(([runId]) => runId),
          (rows) => {
            const liveGroup = readGroup();
            if (
              liveGroup.length !== groupEntries.length ||
              groupEntries.some(([runId, expected]) => {
                const current = rows.get(runId);
                return (
                  !isCleanupCurrent(current, expected) ||
                  !isCollectorArchiveReady(current, now) ||
                  !liveGroup.some(([liveRunId]) => liveRunId === runId)
                );
              })
            ) {
              return { value: false };
            }
            return {
              value: true,
              postimages: new Map(groupEntries.map(([runId]) => [runId, null])),
            };
          },
          { runs },
        );
        if (deleted) {
          for (const [runId] of groupEntries) {
            params.clearPendingLifecycleError(runId);
          }
        }
      }
      params.sweepPendingLifecycle(now);

      stopIfIdle();
    } finally {
      sweepInProgress = false;
      // Count retained delivery after expiry, even when unrelated sweep work fails.
      lastWarnedSuspendedCount = warnSuspendedDeliveryPressure(
        getSubagentSweepRuns(runs, Date.now()),
        lastWarnedSuspendedCount,
        params.warn,
      );
    }
  }

  return {
    start,
    stop,
    stopIfIdle,
    schedule,
    sweepOnce: () => trackWork(sweepOnce),
    runTick: () => trackWork(runTick),
    async reset() {
      stop();
      lastWarnedSuspendedCount = undefined;
      // Accepted sweeps can start cleanup tails before they settle.
      while (pendingWork.size > 0) {
        await Promise.allSettled(pendingWork);
      }
    },
  };
}
