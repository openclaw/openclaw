import type { callGateway } from "../../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayDetachedWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { createLazyImportLoader } from "../../../shared/lazy-promise.js";
import {
  blockSubagentCompletionDelivery,
  reconcileRetiredSubagentCancellation,
} from "../completion/subagent-completion-admission.store.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import type { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { createInterruptedRecoveryCoordinator } from "./subagent-registry-restart-recovery-coordinator.js";
import { isRestoredQueuedFailureSettlementClaimed } from "./subagent-registry-restore.js";
import {
  discardSuspendedPendingFinalDelivery,
  isSuspendedPendingFinalDelivery,
  SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS,
  warnSuspendedDeliveryPressure,
} from "./subagent-registry-suspended-delivery.js";
import {
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
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { hasSubagentRunEnded, isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";
export { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";

const SESSION_RUN_TTL_MS = 5 * 60_000;
const STALE_ACTIVE_SUBAGENT_GRACE_MS = isFastTestRuntimeEnv() ? 1_000 : 60_000;
const restartRecoveryLoader = createLazyImportLoader(
  () => import("./subagent-registry-restart-recovery.js"),
);
const killRuntimeLoader = createLazyImportLoader(() => import("./subagent-control.runtime.js"));
type CompletionRuntime = ReturnType<typeof createSubagentRegistryCompletionRuntime>;

export function createSubagentRegistrySweeper(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<object>;
  clearPendingLifecycleError: (runId: string) => void;
  clearPendingLifecycleTimeout: (runId: string) => void;
  sweepPendingLifecycle: (now: number) => void;
  completeSubagentRunWithRecovery: CompletionRuntime["completeSubagentRunWithRecovery"];
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  finalizeInterruptedSubagentRun: CompletionRuntime["finalizeInterruptedSubagentRun"];
  resumeRequesterSettleWake: SubagentLifecycleController["resumeRequesterSettleWake"];
  startSubagentAnnounceCleanupFlow: SubagentLifecycleController["startSubagentAnnounceCleanupFlow"];
  completeCleanupBookkeeping: SubagentLifecycleController["completeCleanupBookkeeping"];
  isCleanupOwnerCurrent: SubagentLifecycleController["isCleanupOwnerCurrent"];
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
  const { runs, resumedRuns } = params;
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
    if (intervalStarted) {
      return;
    }
    intervalStarted = true;
    schedule({ delayMs: 60_000 });
  }

  function stop() {
    recovery.reset();
    intervalStarted = false;
    clearTimeout(scheduled?.timer);
    scheduled = undefined;
    rerunRequested = false;
  }

  function schedule(options?: { delayMs?: number }) {
    const delayMs = Math.max(0, options?.delayMs ?? 5_000);
    const nextAt = Date.now() + delayMs;
    if (scheduled && scheduled.at <= nextAt) {
      return;
    }
    clearTimeout(scheduled?.timer);
    const timer = setTimeout(() => {
      scheduled = undefined;
      void trackWork(runTick);
    }, delayMs);
    timer.unref?.();
    scheduled = { timer, at: nextAt };
  }

  async function runTick() {
    if (sweepInProgress) {
      rerunRequested = true;
      return;
    }
    try {
      await runWithGatewayDetachedWorkAdmission(sweepOnce, "subagents:sweeper");
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

  const recovery = createInterruptedRecoveryCoordinator({
    runs,
    getRunsForChildSession: params.getRunsForChildSession,
    getGatewayRuntime: params.getGatewayRecoveryRuntime,
    finalizeRun: params.finalizeInterruptedSubagentRun,
    recoverRow: async (recoveryParams) =>
      (await restartRecoveryLoader.load()).recoverInterruptedSubagentRow(recoveryParams),
    schedule: (delayMs) => schedule({ delayMs }),
    warn: params.warn,
  });

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
    try {
      const now = Date.now();
      recovery.prune();
      const collectorArchiveCandidates = new Map<
        string,
        { requesterSessionKey: string; groupId: string; requesterAgentId?: string }
      >();
      const phase = ([runId, entry]: [string, SubagentRunRecord]) =>
        entry.requesterSettleWake
          ? 0
          : isSuspendedPendingFinalDelivery(entry)
            ? 1
            : entry.terminalOwner === "interrupted-recovery"
              ? 2
              : !getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number"
                ? 3
                : entry.killReconciliation
                  ? 4
                  : 5;
      const runEntries = [...runs.entries()].toSorted((left, right) => {
        const phaseDelta = phase(left) - phase(right);
        return (
          phaseDelta ||
          (phase(left) === 3
            ? Number(isStaleUnendedSubagentRun(right[1], now)) -
              Number(isStaleUnendedSubagentRun(left[1], now))
            : 0)
        );
      });
      // Completion stays fresh across awaits, but deletion must retain the earlier
      // CAS identity. Bind it to the exact run so replacements wait for another pass.
      const cleanupIdentities = new Map<object, FrozenSessionIdentity | undefined>();
      for (const [, entry] of runEntries) {
        if (
          typeof entry.execution.endedAt !== "number" ||
          isRestoredQueuedFailureSettlementClaimed(entry) ||
          entry.requesterSettleWake ||
          isSuspendedPendingFinalDelivery(entry) ||
          entry.killIntent ||
          entry.killReconciliation ||
          !(entry.collect && entry.collectorCompletion
            ? entry.collectorLaunchCleanupPending || isCollectorArchiveReady(entry, now)
            : entry.archiveAtMs && entry.archiveAtMs <= now && !isSessionCleanupDeferred(entry))
        ) {
          continue;
        }
        // Suppressed session cleanup still requires the captured member for artifact cleanup.
        cleanupIdentities.set(
          getSubagentRunRuntimeKey(entry),
          shouldSuppressSubagentRecoverySessionEffects(entry)
            ? undefined
            : freezeSessionIdentity(entry.childSessionKey),
        );
      }
      for (const [runId, snapshot] of runEntries) {
        const selected = runs.get(runId);
        if (!selected || !isSameSubagentRunOwner(selected, snapshot)) {
          continue;
        }
        let entry: SubagentRunRecord = selected;
        if (isRestoredQueuedFailureSettlementClaimed(entry)) {
          // The restored FIFO callback owns this row until durable settlement.
          continue;
        }
        if (
          subagentRuns.isCompletionAuthorityRetired(entry) &&
          ["pending", "in_progress"].includes(entry.delivery?.status ?? "")
        ) {
          await blockSubagentCompletionDelivery({
            subagent: entry,
            reason: "store replaced",
            suspendedReason: "permanent_failure",
            storeReplaced: true,
          });
          continue;
        }
        if (
          entry.killReconciliation &&
          (await reconcileRetiredSubagentCancellation(entry, now)) === false
        ) {
          continue;
        }
        const reconciled = runs.get(runId);
        if (!reconciled || !isSameSubagentRunOwner(reconciled, entry)) {
          continue;
        }
        entry = reconciled;
        // Yield freezes the parent's wake before its children finish. Keep
        // terminal delivery priority while unfinished children reach recovery.
        if (
          entry.requesterSettleWake &&
          entry.execution.status !== "running" &&
          hasSubagentRunEnded(entry) &&
          !entry.execution.restartRecovery
        ) {
          params.resumeRequesterSettleWake(runId, entry);
          continue;
        }
        if (isSuspendedPendingFinalDelivery(entry)) {
          const expired =
            now - (entry.delivery?.suspendedAt ?? now) >= SUBAGENT_SUSPENDED_DELIVERY_RETENTION_MS;
          if (expired) {
            await discardSuspendedPendingFinalDelivery({
              runId,
              entry,
              now,
              reason: "expired",
              resumedRuns,
              clearPendingLifecycleError: params.clearPendingLifecycleError,
              clearPendingLifecycleTimeout: params.clearPendingLifecycleTimeout,
              discardTerminalDelivery: params.discardTerminalDelivery,
              completeCleanupBookkeeping: params.completeCleanupBookkeeping,
              isCurrent: () => params.isCleanupOwnerCurrent(runId, entry),
              sessionEffectsHostCurrent: params.sessionEffectsHostCurrent,
              shouldSuppressSessionEffects: params.shouldSuppressSessionEffects,
              shouldEmitEndedHookForRun: params.shouldEmitEndedHookForRun,
              emitSubagentEndedHookForRun: params.emitSubagentEndedHookForRun,
              warn: params.warn,
            });
          }
          continue;
        }
        if (entry.killIntent) {
          await reconcileDurableSubagentKillIntent({
            runId,
            entry,
            runs,
            getRunsForChildSession: params.getRunsForChildSession,
            loadKillRuntime: () => killRuntimeLoader.load(),
            completeSubagentRunWithRecovery: params.completeSubagentRunWithRecovery,
            retireSupersededRun: params.retireSupersededRun,
            warn: params.warn,
          });
          continue;
        }
        if (entry.killReconciliation) {
          await reconcileProvisionalSubagentKill({
            runId,
            entry,
            now,
            runs,
            completeSubagentRunWithRecovery: params.completeSubagentRunWithRecovery,
            retireSupersededRun: params.retireSupersededRun,
            startSubagentAnnounceCleanupFlow: params.startSubagentAnnounceCleanupFlow,
            getRunsForChildSession: params.getRunsForChildSession,
            warn: params.warn,
          });
          continue;
        }
        if (
          (entry.execution.restartRecovery !== undefined ||
            entry.terminalOwner === "interrupted-recovery" ||
            (!getAgentRunContext(runId) && typeof entry.execution.endedAt !== "number")) &&
          (await recovery.recover(runId, entry))
        ) {
          continue;
        }
        if (typeof entry.execution.endedAt !== "number") {
          // Queued collectors have no run context until FIFO dispatch; the scheduler owns them.
          const notStale = entry.execution.status === "queued" || getAgentRunContext(runId);
          const activeAgeMs = now - (entry.execution.startedAt ?? entry.createdAt);
          if (!notStale && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
            const orphanReason = resolveSubagentRunOrphanReason({ entry });
            const sessionEntry = loadSubagentSessionEntry({
              childSessionKey: entry.childSessionKey,
            });
            const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
              notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
            });
            if (completion) {
              await params.completeSubagentRunWithRecovery(
                {
                  runId,
                  startedAt: completion.startedAt,
                  endedAt: completion.endedAt,
                  outcome: completion.outcome,
                  reason: completion.reason,
                  sendFarewell: true,
                  accountId: entry.requesterOrigin?.accountId,
                  triggerCleanup: true,
                },
                "sweeper-session-completion",
              );
              continue;
            }

            await params.completeSubagentRunWithRecovery(
              {
                runId,
                expectedEntry: entry,
                endedAt: now,
                outcome: {
                  status: "error",
                  error: orphanReason
                    ? `subagent run orphaned: ${orphanReason}`
                    : "subagent run lost active execution context",
                },
                reason: SUBAGENT_ENDED_REASON_ERROR,
                sendFarewell: true,
                accountId: entry.requesterOrigin?.accountId,
                triggerCleanup: true,
              },
              "sweeper-lost-context",
            );
            continue;
          }
          // Retention starts after completion; a live run must never fall
          // through to archival because an older persisted deadline expired.
          continue;
        }

        if (entry.collect && entry.collectorCompletion) {
          if (entry.collectorLaunchCleanupPending) {
            let suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
            if (!suppressSessionEffects) {
              if (!cleanupIdentities.has(getSubagentRunRuntimeKey(entry))) {
                continue;
              }
              const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(entry));
              if (!sessionIdentity) {
                suppressSessionEffects = true;
              } else {
                try {
                  suppressSessionEffects =
                    (await deleteSweptSession(entry, sessionIdentity, runs, params.callGateway)) ===
                    "changed";
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
                return draft;
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
              now - current.cleanupCompletedAt > SESSION_RUN_TTL_MS,
            () => null,
          );
          if (deleted === null) {
            params.clearPendingLifecycleError(runId);
            if (!shouldSuppressSubagentRecoverySessionEffects(entry)) {
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
        const suppressSessionEffects = shouldSuppressSubagentRecoverySessionEffects(entry);
        let sessionOwnershipChanged = false;
        if (!suppressSessionEffects) {
          if (!cleanupIdentities.has(getSubagentRunRuntimeKey(entry))) {
            continue;
          }
          const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(entry));
          if (!sessionIdentity) {
            sessionOwnershipChanged = true;
          } else {
            try {
              sessionOwnershipChanged =
                (await deleteSweptSession(entry, sessionIdentity, runs, params.callGateway)) ===
                "changed";
            } catch (error) {
              params.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
                runId,
                childSessionKey: entry.childSessionKey,
                error,
              });
              continue;
            }
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
              !isCollectorArchiveReady(candidate, now) ||
              !cleanupIdentities.has(getSubagentRunRuntimeKey(candidate)) ||
              !isCleanupCurrent(candidate, candidate),
          )
        ) {
          continue;
        }
        for (const [candidateRunId, candidate] of groupEntries) {
          let current = runs.get(candidateRunId);
          if (!isCleanupCurrent(current, candidate) || !isCollectorArchiveReady(current, now)) {
            continue collectorGroups;
          }
          if (!shouldSuppressSubagentRecoverySessionEffects(current)) {
            const sessionIdentity = cleanupIdentities.get(getSubagentRunRuntimeKey(candidate));
            try {
              const changed =
                !sessionIdentity ||
                (await deleteSweptSession(current, sessionIdentity, runs, params.callGateway)) ===
                  "changed";
              if (changed) {
                const updated = await mutateCleanup(
                  runs,
                  current,
                  (row) => Boolean(isCollectorArchiveReady(row, now)),
                  (draft) => {
                    draft.execution.suppressSessionEffects = true;
                    return draft;
                  },
                );
                if (!updated) {
                  continue collectorGroups;
                }
                current = updated;
              }
            } catch (error) {
              params.warn("sessions.delete failed during collector group sweep; keeping group", {
                runId: candidateRunId,
                childSessionKey: candidate.childSessionKey,
                groupId,
                error,
              });
              continue collectorGroups;
            }
          }
          if (!isCleanupCurrent(runs.get(candidateRunId), candidate)) {
            continue collectorGroups;
          }
          if (!(await safeRemoveAttachmentsDir(current))) {
            params.warn("attachment cleanup failed during collector group sweep; keeping group", {
              runId: candidateRunId,
              childSessionKey: candidate.childSessionKey,
              groupId,
            });
            continue collectorGroups;
          }
          if (
            current.cleanup !== "delete" &&
            !shouldSuppressSubagentRecoverySessionEffects(current) &&
            typeof current.contextEngineCleanupCompletedAt !== "number"
          ) {
            try {
              await params.runContextEngineSubagentEnded(sweptContext(current));
              if (
                !(await mutateCleanup(
                  runs,
                  current,
                  (row) => Boolean(isCollectorArchiveReady(row, now)),
                  (draft) => {
                    draft.contextEngineCleanupCompletedAt = Date.now();
                    return draft;
                  },
                ))
              ) {
                continue collectorGroups;
              }
            } catch (error) {
              params.warn(
                "context-engine cleanup failed during collector group sweep; keeping group",
                {
                  runId: candidateRunId,
                  childSessionKey: candidate.childSessionKey,
                  groupId,
                  error,
                },
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

      if (runs.size === 0) {
        stop();
      }
    } finally {
      sweepInProgress = false;
      // Count retained delivery after expiry, even when unrelated sweep work fails.
      lastWarnedSuspendedCount = warnSuspendedDeliveryPressure(
        runs.values(),
        lastWarnedSuspendedCount,
        params.warn,
      );
    }
  }

  return {
    start,
    stop,
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
