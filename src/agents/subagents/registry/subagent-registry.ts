import { getRuntimeConfig } from "../../../config/config.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "../../../gateway/server-startup-trace.js";
import { registerSystemEventStoreOwner } from "../../../infra/system-event-ownership.js";
import {
  runWithGatewayDetachedWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { findSessionControllerOperationByRunId } from "../../../sessions/session-controller.queries.js";
import { runInDetachedAsyncContext } from "../../../shared/detached-async-context.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { reconcileRetiredSubagentCancellation } from "../completion/subagent-completion-admission.store.js";
import { terminateAcceptedCollectorRun } from "../spawn/subagent-spawn-cleanup.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  createSubagentRegistryCompletionRuntime,
  createSubagentResumeReader,
} from "./subagent-registry-completion-runtime.js";
import { emitSubagentProgressEndedHook } from "./subagent-registry-completion.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  callSubagentRegistryGateway,
  createSubagentRegistryGatewayCaller,
  loadSubagentAnnounceModule,
  loadSubagentBrowserCleanupModule,
} from "./subagent-registry-deps.js";
import { bindSubagentRunGatewayOwners } from "./subagent-registry-gateway-owner.js";
import {
  ANNOUNCE_EXPIRY_MS,
  GATEWAY_ADMISSION_RETRY_DELAY_MS,
} from "./subagent-registry-helpers.js";
import { suspendReplacedStoreNotifications } from "./subagent-registry-lifecycle-cleanup.js";
import { subagentRegistryLog as log } from "./subagent-registry-lifecycle-log.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import {
  getSubagentChildSessionCandidates,
  getSubagentRunsForChildSession,
  getSubagentRunsForCollectorGroup,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import {
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
import { captureRequesterSettleWakeRecoverySource } from "./subagent-registry-restart-recovery.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-launch-record.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import { reconcileProvisionalSubagentKill } from "./subagent-registry-sweep-kill.js";
import {
  createSubagentRegistrySweeper,
  retireSupersededSubagentRun as retireSupersededSubagentRunForSweep,
} from "./subagent-registry-sweeper.js";
import type { RegisterSubagentRunOptions, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  isRequesterRetirementCustodyCurrent,
  isRequesterCompletionCohortCurrent,
} from "./subagent-requester-settle-identity.js";
import { isClaimedByLiveRequesterTurn } from "./subagent-requester-turn-liveness.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { resolveSubagentWaitTimeoutMs } from "./subagent-run-timeout.js";
import {
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  type SubagentRunOrphanReason,
} from "./subagent-session-reconciliation.js";

export { SubagentSessionCleanupRevocationChangedError } from "./subagent-registry-lifecycle.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";
const warn = (message: string, meta?: Record<string, unknown>) => log.warn(message, meta);

const completionRetryTimers = new Set<ReturnType<typeof setTimeout>>();
let activeGatewayContextResolver: GatewayContextResolver | undefined;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;

/** Prepare registry hydration before the session owner's synchronous reset commit. */
export async function prepareSubagentSessionCleanupRevocation(
  sessionKey: string,
  childAgentId?: string,
  assertCurrent?: () => void,
): Promise<() => void> {
  await subagentRestorer.restoreOnce(true);
  await subagentLifecycleController.revokeTerminalSessionEffects(
    getSubagentRunsForChildSession(sessionKey, childAgentId),
    assertCurrent,
  );
  return () => {
    assertCurrent?.();
    subagentLifecycleController.assertTerminalSessionEffectsRevoked(
      getSubagentRunsForChildSession(sessionKey, childAgentId),
    );
  };
}

export function scheduleSubagentRegistrySweep(params?: { delayMs?: number }) {
  subagentSweeper.schedule(params);
}

const resumedRuns = new Set<object>();
const resumeReader = createSubagentResumeReader({
  resumedRuns,
  runBackgroundWork: (entry, run) => subagentLifecycleController.runBackgroundWork(entry, run),
  getGatewayContextResolver: () => activeGatewayContextResolver,
  resume: resumeCheckedSubagentRun,
  retryAfterDrain: (...args) => subagentLifecycleController.resumeAfterDrain(...args),
});

const completionRuntime = createSubagentRegistryCompletionRuntime({
  runs: subagentRuns,
  resumed: resumedRuns,
  retryTimers: completionRetryTimers,
  completeSubagentRun: (params) => completeSubagentRun(params),
  scheduleSweep: scheduleSubagentRegistrySweep,
  resumeRun: (runId) => resumeSubagentRun(runId),
});
const pendingLifecycle = completionRuntime.pendingLifecycle;
const clearPendingLifecycleError = pendingLifecycle.clearError;
const clearPendingLifecycleTimeout = pendingLifecycle.clearTimeout;

const contextCleanup = createSubagentRegistryContextCleanup({
  isEndedHookOwnerCurrent: (entry): boolean =>
    subagentLifecycleController.isEndedHookOwnerCurrent(entry),
});

const subagentLifecycleController = new SubagentLifecycleController({
  ...contextCleanup,
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  getRuntimeConfig,
  clearPendingLifecycleError,
  // Lifecycle wiring precedes publicApi construction; inject this read query
  // as a late-bound callback instead of threading a partially built API object.
  countPendingDescendantRuns,
  getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
  emitSubagentProgressEndedForRun: emitSubagentProgressEndedHook,
  retireSupersededRun: retireSupersededSubagentRun,
  resumeSubagentRun,
  confirmProvisionalKill: confirmProvisionalSubagentKill,
  callGateway: callSubagentRegistryGateway,
  captureSubagentCompletionReply: async (sessionKey, options) =>
    (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: async (args) =>
    (await loadSubagentBrowserCleanupModule()).cleanupBrowserSessionsForLifecycleEnd(args),
  runSubagentAnnounceFlow: async (params) =>
    (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params),
  maybeWakeRequesterAfterAllChildrenSettled: async (args) =>
    subagentRestorer.canResumeWakes()
      ? (
          await import("../announce/subagent-announce.requester-settle-wake.js")
        ).maybeWakeRequesterAfterAllChildrenSettled(args)
      : false,
  warn,
});

const {
  clearRuntimeState,
  scheduleResume,
  completeCleanupBookkeeping,
  completeSubagentRun,
  finalizeResumedAnnounceGiveUpInBackground,
  refreshFrozenResultFromSession,
  resumeRequesterSettleWake,
  resumePendingRequesterSettlements,
  settleRequesterTurnAfterSessionSpawns,
  startSubagentAnnounceCleanupFlow,
} = subagentLifecycleController;
function suspendReplacedNotificationsInBackground(): void {
  void suspendReplacedStoreNotifications(subagentLifecycleController.options).catch(
    (error: unknown) => {
      log.warn("subagent notification retirement is deferred", { error });
    },
  );
}
registerSystemEventStoreOwner(
  Symbol.for("openclaw.subagentNotifications"),
  suspendReplacedNotificationsInBackground,
);

export function resumeSubagentRun(runId: string, source: "live" | "restore" = "live") {
  if (!runId) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (
    !entry ||
    resumedRuns.has(getSubagentRunRuntimeKey(entry)) ||
    subagentRuns.isCompletionAuthorityRetired(entry)
  ) {
    return;
  }
  if (entry.terminalOwner === "interrupted-recovery") {
    resumeReader.retirePending(entry);
    if (source === "restore") {
      // Startup recovery owns terminal reconciliation and resource cleanup before delivery.
      resumedRuns.add(getSubagentRunRuntimeKey(entry));
      return;
    }
    // The recovery completion path has run; live retries only resume its delivery.
    resumeCheckedSubagentRun(runId, entry, source, null);
    return;
  }
  const orphanCheck = resolveSubagentRunOrphanReason({
    entry,
    includeStaleUnended: source === "restore",
  });
  if (orphanCheck === null || typeof orphanCheck === "string") {
    resumeReader.retirePending(entry);
    resumeCheckedSubagentRun(runId, entry, source, orphanCheck);
    return;
  }
  if (!resumeReader.hasPending(entry)) {
    resumeReader.read(runId, entry, source, orphanCheck);
  }
}

function resumeCheckedSubagentRun(
  runId: string,
  entry: SubagentRunRecord,
  source: "live" | "restore",
  orphanReason: SubagentRunOrphanReason | null,
  isHostCurrent?: () => boolean,
) {
  if (source === "restore" && entry.requesterSettleWake) {
    subagentLifecycleController.markRequesterSettleWakeRestored(entry);
  }
  if (orphanReason) {
    // An orphan still owns its task and requester obligation. Settle through
    // the same completion path before cleanup can remove that ownership.
    void completionRuntime
      .completeSubagentRunWithRecovery(
        {
          runId,
          expectedEntry: entry,
          endedAt: entry.execution.endedAt ?? Date.now(),
          outcome: { status: "error", error: `subagent run orphaned: ${orphanReason}` },
          reason: SUBAGENT_ENDED_REASON_ERROR,
          triggerCleanup: true,
          ...(isHostCurrent
            ? { recoveryCurrent: { isHostCurrent, prepare: async () => isHostCurrent() } }
            : {}),
        },
        "orphan-resume",
      )
      .catch((error: unknown) => {
        log.warn("failed to settle orphaned subagent run", { runId, error });
      });
    return;
  }
  if (entry.killReconciliation) {
    resumedRuns.add(getSubagentRunRuntimeKey(entry));
    const stillCurrent = () =>
      isHostCurrent?.() !== false && isSameSubagentRunOwner(subagentRuns.get(runId), entry);
    const failed = (error: unknown) => {
      log.warn("subagent settlement deferred before cleanup", { runId, error });
      if (stillCurrent()) {
        resumedRuns.delete(getSubagentRunRuntimeKey(entry));
        scheduleResume(entry, GATEWAY_ADMISSION_RETRY_DELAY_MS);
      }
    };
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      try {
        const settled = await reconcileRetiredSubagentCancellation(entry, Date.now());
        if (!stillCurrent()) {
          return;
        }
        resumedRuns.delete(getSubagentRunRuntimeKey(entry));
        if (settled === false) {
          scheduleSubagentRegistrySweep();
          return;
        }
        resumeFinalizedSubagentRun(runId, subagentRuns.get(runId)!);
      } catch (error) {
        failed(error);
      }
    }, "subagents:cancel-reconcile").catch(failed);
    return;
  }
  resumeFinalizedSubagentRun(runId, entry);
}

/** Retires a killed row's obligations, re-evaluating its yielded cohort. */
function retireKilledSubagentObligations(entry: SubagentRunRecord): Promise<void> {
  return subagentLifecycleController.retireSubagentObligations(entry, () => {
    if (!isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry)) {
      throw new Error("Killed subagent row changed before obligation retirement.");
    }
  });
}

// Runs whose kill owner is still settling its claim, and whether a confirmation waited on it.
const settlingKillOwners = new Map<string, { owners: number; deferred: boolean }>();

/**
 * Runs one kill owner's claim settlement. A kill confirmation that arrives meanwhile waits,
 * and runs once the last owner finishes publishing under its claim.
 */
export async function withSubagentKillOwner<T>(
  runId: string,
  settle: () => Promise<T>,
): Promise<T> {
  const owner = settlingKillOwners.get(runId) ?? { owners: 0, deferred: false };
  owner.owners += 1;
  settlingKillOwners.set(runId, owner);
  try {
    return await settle();
  } finally {
    owner.owners -= 1;
    if (owner.owners === 0) {
      settlingKillOwners.delete(runId);
      const current = subagentRuns.get(runId);
      if (owner.deferred && current?.killReconciliation) {
        confirmProvisionalSubagentKill(current);
      }
    }
  }
}

/**
 * Confirms a provisional kill once the killed run's controller operation settles, when its
 * canonical outcome is final, and once a live requester turn that claims the row has
 * transferred its children. Without such operations the kill confirms immediately; a kill
 * owner still settling its claim confirms it itself when done.
 */
function confirmProvisionalSubagentKill(entry: SubagentRunRecord): void {
  const settlements = [entry.runId, entry.requesterTurnRunId].flatMap((runId) => {
    const operation = runId ? findSessionControllerOperationByRunId(runId) : undefined;
    return operation ? [operation.ownerSettlement] : [];
  });
  // The caller may be the killed run's own terminal callback; never inherit its turn context.
  void runInDetachedAsyncContext(() => confirmAfterSettlements(entry, settlements));
}

async function confirmAfterSettlements(
  entry: SubagentRunRecord,
  settlements: readonly Promise<void>[],
): Promise<void> {
  await Promise.allSettled(settlements);
  await runWithGatewayDetachedWorkAdmission(async () => {
    const current = subagentRuns.get(entry.runId);
    if (!current?.killReconciliation || !isSameSubagentRunOwner(current, entry)) {
      return;
    }
    const owner = settlingKillOwners.get(current.runId);
    if (owner) {
      owner.deferred = true;
      return;
    }
    await reconcileProvisionalSubagentKill({
      runId: current.runId,
      entry: current,
      now: Date.now(),
      runs: subagentRuns,
      completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
      retireSupersededRun: retireSupersededSubagentRun,
      retireObligations: retireKilledSubagentObligations,
      startSubagentAnnounceCleanupFlow,
      getRunsForChildSession: getSubagentRunsForChildSession,
      warn,
    });
  }, "subagents:kill-confirm").catch((error: unknown) => {
    // The sweeper reconciles a kill whose confirmation could not run here.
    log.warn("failed to confirm provisional subagent kill", { runId: entry.runId, error });
  });
}

function resumeFinalizedSubagentRun(runId: string, entry: SubagentRunRecord) {
  // A yielded wake waits only while a delivery owner remains: the session queue, or
  // this row's own unfinished cleanup. Completed cleanup leaves the wake as the owner.
  const yieldedWakeWaitingForDelivery =
    entry.requesterSettleWake?.requesterYieldBatch === true &&
    (entry.delivery?.status === "in_progress" ||
      (entry.cleanupCompletedAt === undefined &&
        (entry.delivery?.status === "pending" || entry.delivery?.status === "failed")));
  if (
    entry.requesterSettleWake &&
    typeof entry.execution.endedAt === "number" &&
    (!yieldedWakeWaitingForDelivery ||
      (entry.pauseReason === "sessions_yield" && entry.requesterSettleWake.pauseNotice))
  ) {
    resumeRequesterSettleWake(runId, entry);
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  if (typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry)) {
    return;
  }
  if (entry.delivery?.status === "in_progress") {
    // The durable session queue resumes this delivery from its own owner row.
    return;
  }
  // Yielded runs stay paused until explicitly steered, except orchestrators
  // waiting on descendants: their settle retry must reach the wake path.
  if (entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true) {
    return;
  }
  // Required completions are deadline-driven; retry count is diagnostic only.
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.execution.endedAt === "number" &&
    Date.now() - entry.execution.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    finalizeResumedAnnounceGiveUpInBackground(runId, entry, "expiry");
    return;
  }

  const now = Date.now();
  const earliestRetryAt = entry.delivery?.nextAttemptAt ?? 0;
  if (entry.expectsCompletionMessage === true && now < earliestRetryAt) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    scheduleResume(entry, waitMs);
    resumedRuns.add(getSubagentRunRuntimeKey(entry));
    return;
  }

  if (typeof entry.execution.endedAt === "number" && entry.execution.endedAt > 0) {
    // Operation settlement or, without one, the sweeper owns provisional cancellation cleanup.
    if (
      entry.killReconciliation ||
      contextCleanup.suppressAnnounceForSteerRestart(entry) ||
      startSubagentAnnounceCleanupFlow(entry)
    ) {
      resumedRuns.add(getSubagentRunRuntimeKey(entry));
    }
    return;
  }

  // Wait for completion again after restart.
  const cfg = getRuntimeConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void subagentRunManager.waitForSubagentCompletion(runId, entry, waitTimeoutMs, true);
  resumedRuns.add(getSubagentRunRuntimeKey(entry));
}

const subagentRestorer = createSubagentRegistryRestorer({
  runs: subagentRuns,
  getGatewayContextResolver: () => activeGatewayContextResolver,
  bindGatewayOwners: async (entries, startupTrace, onRecovered) => {
    if (
      !(await bindSubagentRunGatewayOwners({
        runs: subagentRuns,
        entries,
        startupTrace,
        resumedRuns,
        getGatewayContextResolver: () => activeGatewayContextResolver,
        onRecovered: (entry) => {
          onRecovered(entry);
          subagentLifecycleController.markRequesterSettleWakeRestored(entry);
        },
      }))
    ) {
      return false;
    }
    suspendReplacedNotificationsInBackground();
    return true;
  },
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
  retireSupersededRun: retireSupersededSubagentRun,
  ensureListener: () => subagentListener.ensure(),
  startSweeper: () => subagentSweeper.start(),
  scheduleSweep: scheduleSubagentRegistrySweep,
  recoverInterruptedRuns: (entries, startupTrace) =>
    measureStartup(startupTrace, "background.subagent-interrupted", () =>
      subagentSweeper.recoverInterruptedRuns(entries),
    ).catch((error: unknown) => {
      log.warn("interrupted subagent recovery remains pending", { error });
    }),
  resumeRun: (runId) => resumeSubagentRun(runId, "restore"),
  listSwarmRunsForGroup: (groupId, requesterSessionKey, requesterAgentId) =>
    listSwarmRunsForGroup(groupId, requesterSessionKey, requesterAgentId),
  startQueuedSubagentRun: (runId, gatewayRunId, lifecycleGeneration) =>
    subagentRunManager.startQueuedSubagentRun(runId, gatewayRunId, lifecycleGeneration),
  terminateAcceptedRestoredCollectorRun: ({
    entry,
    gatewayRunId,
    timeoutMs,
    expectedSessionId,
    expectedLifecycleRevision,
  }) =>
    terminateAcceptedCollectorRun({
      childSessionKey: entry.childSessionKey,
      gatewayRunId,
      expectedSessionId,
      expectedLifecycleRevision,
      timeoutMs,
      callGateway: callSubagentRegistryGateway,
    }),
  cleanupCollectorLaunchResources: contextCleanup.cleanupCollectorLaunchResources,
  settleFailedQueuedSubagentLaunch: (runId, error) =>
    subagentRunManager.settleFailedQueuedSubagentLaunch(runId, error),
  completeCollectorLaunchCleanup: (runId) => publicApi.completeCollectorLaunchCleanup(runId),
  warn,
});

function retireSupersededSubagentRun(
  runId: string,
  expected: SubagentRunRecord,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const entry = subagentRuns.get(runId);
  if (
    !entry ||
    !isSameSubagentRunOwner(entry, expected) ||
    !isRequesterRetirementCustodyCurrent(entry, expected)
  ) {
    return Promise.resolve();
  }
  const wake = entry.requesterSettleWake;
  const owesCompletion =
    entry.expectsCompletionMessage === true &&
    entry.suppressCompletionDelivery !== true &&
    !entry.killIntent &&
    !entry.killReconciliation;
  if (
    owesCompletion &&
    entry.execution.status === "terminal" &&
    !isClaimedByLiveRequesterTurn(entry) &&
    !wake &&
    !entry.cleanupCompletedAt
  ) {
    startSubagentAnnounceCleanupFlow(entry);
    return Promise.resolve();
  }
  const isCurrent = () =>
    isSameSubagentRunOwner(subagentRuns.get(runId), entry) &&
    isRequesterCompletionCohortCurrent(entry, getLatestLiveSubagentRunByChildSessionKey);
  const inRequesterCohort =
    Boolean(entry.requesterTurnRunId) || wake?.batchRunIds?.includes(entry.runId) === true;
  if (owesCompletion && inRequesterCohort && isCurrent()) {
    // A newer task owns session effects, but this cohort still owes the older result.
    if (entry.cleanupCompletedAt !== undefined) {
      resumeRequesterSettleWake(runId, entry);
      return Promise.resolve();
    }
    return completeCleanupBookkeeping({
      runId,
      entry,
      cleanup: entry.cleanup,
      completedAt: Date.now(),
      preserveTranscript: true,
      isCurrent,
    });
  }
  return retireSupersededSubagentRunForSweep({
    runId,
    entry,
    runs: subagentRuns,
    clearPendingLifecycleError,
    assertCurrent,
    isCurrent: (current) => {
      assertCurrent?.();
      return isRequesterRetirementCustodyCurrent(current, entry);
    },
  }).then(() => {
    if (!subagentRuns.has(runId)) {
      subagentLifecycleController.resumeAncestorCleanup(entry);
    }
  });
}

const subagentSweeper = createSubagentRegistrySweeper({
  ...contextCleanup,
  runs: subagentRuns,
  resumedRuns,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  sweepPendingLifecycle: (now) => pendingLifecycle.sweepExpired(now),
  completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
  getGatewayRecoveryRuntime: () => activeGatewayContextResolver?.()?.recoveryRuntime,
  finalizeInterruptedSubagentRun: completionRuntime.finalizeInterruptedSubagentRun,
  startSubagentAnnounceCleanupFlow,
  completeCleanupBookkeeping,
  resumeRequesterSettleWake,
  resumePendingRequesterSettlements,
  isCleanupOwnerCurrent: subagentLifecycleController.isCleanupOwnerCurrent,
  isTerminalTailActive: subagentLifecycleController.isTerminalTailActive,
  sessionEffectsHostCurrent: (entry) =>
    subagentLifecycleController.sessionEffectsHostCurrent(entry),
  shouldSuppressSessionEffects: (entry, effects) =>
    subagentLifecycleController.shouldSuppressSessionEffects(entry, effects),
  discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
  callGateway: callSubagentRegistryGateway,
  retireSupersededRun: retireSupersededSubagentRun,
  retireObligations: retireKilledSubagentObligations,
  getRunsForChildSession: getSubagentRunsForChildSession,
  getRunsForCollectorGroup: getSubagentRunsForCollectorGroup,
  warn,
});

const subagentListener = createSubagentRegistryListener({
  runs: subagentRuns,
  pendingLifecycle,
  resumeRequesterSettleWake,
  adoptPausedSubagentRunIntoSuccessor: (entry) =>
    subagentRunManager.adoptPausedSubagentRunIntoSuccessor({
      childSessionKey: entry.childSessionKey,
      childAgentId: entry.childAgentId,
    }),
  refreshFrozenResultFromSession,
  completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
});

const subagentRunManager = createSubagentRunManager({
  acquireTerminalCompletionLock: (runId) =>
    subagentLifecycleController.acquireTerminalCompletionLock(runId),
  runs: subagentRuns,
  getChildSessionCandidates: getSubagentChildSessionCandidates,
  getRunsForChildSession: getSubagentRunsForChildSession,
  resumedRuns,
  callGateway: createSubagentRegistryGatewayCaller(() => activeGatewayContextResolver),
  getRuntimeConfig,
  ensureListener: subagentListener.ensure,
  startSweeper: subagentSweeper.start,
  stopSweeper: subagentSweeper.stopIfIdle,
  resumeSubagentRun,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  resolveSubagentWaitTimeoutMs,
  scheduleSweep: scheduleSubagentRegistrySweep,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun: async (params) => {
    await completionRuntime.completeSubagentRunWithRecovery(params, "subagent-wait");
  },
});

export const replaceSubagentRunAfterSteerCore = subagentRunManager.replaceSubagentRunAfterSteer;
export const claimSubagentRunKill = subagentRunManager.claimSubagentRunKill;
export const releaseSubagentRunKillClaim = subagentRunManager.releaseSubagentRunKillClaim;
export function registerSubagentRun(
  params: RegisterSubagentRunParams,
  options?: RegisterSubagentRunOptions,
): Promise<void> {
  return subagentRunManager.registerSubagentRun(
    {
      ...params,
      gatewayContextResolver: params.gatewayContextResolver ?? activeGatewayContextResolver,
    },
    options,
  );
}
export const startQueuedSubagentRun = subagentRunManager.startQueuedSubagentRun;
export const settleFailedQueuedSubagentLaunch = subagentRunManager.settleFailedQueuedSubagentLaunch;

export const adoptPausedSubagentRunForFollowUp =
  subagentRunManager.adoptPausedSubagentRunForFollowUp;
export const adoptPausedSubagentRunIntoSuccessor =
  subagentRunManager.adoptPausedSubagentRunIntoSuccessor;

async function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  if (opts?.persist !== false) {
    await mutateSubagentRuns([...subagentRuns.keys()], (rows) => ({
      value: undefined,
      postimages: new Map([...rows.keys()].map((id) => [id, null])),
    }));
  }
  clearRuntimeState();
  for (const timer of completionRetryTimers) {
    clearTimeout(timer);
  }
  completionRetryTimers.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  pendingLifecycle.clearAll();
  clearSubagentRunsReadCacheForTest();
  const sweeperRetirement = subagentSweeper.reset();
  subagentRestorer.reset();
  activeGatewayContextResolver = undefined;
  subagentListener.reset();
  return sweeperRetirement;
}

const testing = {
  sweepOnceForTests: subagentSweeper.sweepOnce,
  runSweeperTickForTests: subagentSweeper.runTick,
} as const;

export const finalizeInterruptedSubagentRun = completionRuntime.finalizeInterruptedSubagentRun;
export const markSubagentRunTerminated = subagentRunManager.markSubagentRunTerminated;
export const retireSubagentObligations = subagentLifecycleController.retireSubagentObligations;

const publicApi = createSubagentRegistryPublicApi({
  runs: subagentRuns,
  restoreOnce: (context) => subagentRestorer.restoreOnce(true, context),
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
  markRequesterYielded: subagentLifecycleController.markRequesterTurnYielded,
});

export const getSubagentRunByRunId = publicApi.getSubagentRunByRunId;
export const prepareSubagentRunsByRunIds = publicApi.prepareSubagentRunsByRunIds;
export const listCollectorRunsForRequesterIncarnation =
  publicApi.listCollectorRunsForRequesterIncarnation;
export const completeCollectorLaunchCleanup = publicApi.completeCollectorLaunchCleanup;
export const recordSwarmStructuredOutput = publicApi.recordSwarmStructuredOutput;
export const listSwarmRunsForGroup = publicApi.listSwarmRunsForGroup;
export const getSwarmRunByLaunchReplayKey = publicApi.getSwarmRunByLaunchReplayKey;
export const countActiveRunsForSession = publicApi.countActiveRunsForSession;
export function initSubagentRegistry() {
  return subagentRestorer.restoreOnce();
}

export async function prepareRequesterSettleWakeRecoverySource(
  params: Omit<Parameters<typeof captureRequesterSettleWakeRecoverySource>[0], "context">,
) {
  const context = captureOpenClawStateWorkerContext();
  await subagentRestorer.restoreOnce(true, context);
  const physical = await prepareSqliteTargetFromSessionStorePath(params.storePath, {
    agentId: params.requesterAgentId,
  });
  return captureRequesterSettleWakeRecoverySource({ ...params, storePath: physical.path, context });
}
export function activateSubagentRegistry(
  resolveGatewayContext: GatewayContextResolver,
  startupTrace?: GatewayStartupTrace,
) {
  // Reuse the instance's own fenced closure so late-restored siblings share one
  // authority across repeated activation; the raw holder can outlive that instance.
  activeGatewayContextResolver = resolveGatewayContext()?.resolveGatewayContext;
  return subagentRestorer.activate(startupTrace);
}
export const settleRequesterAfterSessionSpawns = publicApi.settleRequesterAfterSessionSpawns;
export const markRequesterTurnYielded = publicApi.markRequesterTurnYielded;
export const claimSubagentYield = publicApi.claimSubagentYield;
export const listUnsettledRequesterChildren = publicApi.listUnsettledRequesterChildren;
export type { UnsettledRequesterChild } from "./subagent-registry-requester-yield.js";

export const adoptSubagentRunForRequesterTurn =
  subagentLifecycleController.adoptSubagentRunForRequesterTurn;

const SUBAGENT_REGISTRY_TEST_HANDLE = Symbol.for("openclaw.subagentRegistryTestApi");
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[SUBAGENT_REGISTRY_TEST_HANDLE] = {
    releaseSubagentRun: subagentRunManager.releaseSubagentRun,
    resetSubagentRegistryForTests,
    testing,
  };
}

// Register the subagent maintenance preserve-key provider as a module side effect.
import "./subagent-registry-maintenance.js";
