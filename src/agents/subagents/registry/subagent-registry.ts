import type { AgentWaitParams } from "../../../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../../../config/config.js";
import type { callGateway } from "../../../gateway/call.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { registerSystemEventStoreOwner } from "../../../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { prependAgentSteeringPrompt } from "../../agent-steering-queue.js";
import { reconcileRetiredSubagentCancellation } from "../completion/subagent-completion-admission.store.js";
import { terminateAcceptedCollectorRun } from "../spawn/subagent-spawn-cleanup.js";
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { emitSubagentProgressEndedHook } from "./subagent-registry-completion.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  callSubagentRegistryGateway,
  loadSubagentAnnounceModule,
  loadSubagentBrowserCleanupModule,
  resetSubagentRegistryRuntimeLoadersForTests,
} from "./subagent-registry-deps.js";
import { recoverSubagentRunGatewayOwner } from "./subagent-registry-gateway-owner.js";
import { ANNOUNCE_EXPIRY_MS } from "./subagent-registry-helpers.js";
import { suspendReplacedStoreNotifications } from "./subagent-registry-lifecycle-cleanup.js";
import { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import {
  getSubagentRunsForChildSession,
  getSubagentRunsForCollectorGroup,
  subagentRuns,
} from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
} from "./subagent-registry-persistence.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import {
  countPendingDescendantRuns,
  getLatestLiveSubagentRunByChildSessionKey,
} from "./subagent-registry-read.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import type { RegisterSubagentRunParams } from "./subagent-registry-run-launch-record.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import {
  createSubagentRegistrySweeper,
  retireSupersededSubagentRun as retireSupersededSubagentRunForSweep,
} from "./subagent-registry-sweeper.js";
import type { RegisterSubagentRunOptions, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  isRequesterRetirementCustodyCurrent,
  isRequesterCompletionCohortCurrent,
} from "./subagent-requester-settle-identity.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";
import { resolveSubagentWaitTimeoutMs } from "./subagent-run-timeout.js";
import {
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

export { SubagentSessionCleanupRevocationChangedError } from "./subagent-registry-lifecycle.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";
const log = createSubsystemLogger("agents/subagent-registry");
const warn = (message: string, meta?: Record<string, unknown>) => log.warn(message, meta);

const resumeRetryTimers = new Set<ReturnType<typeof setTimeout>>();
let activeGatewayContextResolver: GatewayContextResolver | undefined;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const GATEWAY_ADMISSION_RETRY_DELAY_MS = 1_000;

/** Prepare registry hydration before the session owner's synchronous reset commit. */
export async function prepareSubagentSessionCleanupRevocation(
  sessionKey: string,
  childAgentId?: string,
  assertCurrent?: () => void,
): Promise<() => void> {
  await subagentRestorer.restoreOnce(undefined, true);
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

const completionRuntime = createSubagentRegistryCompletionRuntime({
  runs: subagentRuns,
  resumed: resumedRuns,
  retryTimers: resumeRetryTimers,
  completeSubagentRun: (params) => completeSubagentRun(params),
  scheduleSweep: scheduleSubagentRegistrySweep,
  resumeRun: (runId) => resumeSubagentRun(runId),
  warn,
});
const pendingLifecycle = completionRuntime.pendingLifecycle;
const clearPendingLifecycleError = pendingLifecycle.clearError;
const clearPendingLifecycleTimeout = pendingLifecycle.clearTimeout;

const contextCleanup = createSubagentRegistryContextCleanup({
  isEndedHookOwnerCurrent: (entry): boolean =>
    subagentLifecycleController.isEndedHookOwnerCurrent(entry),
  warn,
});

const subagentLifecycleController = new SubagentLifecycleController({
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  getRuntimeConfig,
  clearPendingLifecycleError,
  // Lifecycle wiring precedes publicApi construction; inject this read query
  // as a late-bound callback instead of threading a partially built API object.
  countPendingDescendantRuns,
  getLatestRunForChildSession: getLatestLiveSubagentRunByChildSessionKey,
  suppressAnnounceForSteerRestart: contextCleanup.suppressAnnounceForSteerRestart,
  shouldEmitEndedHookForRun: contextCleanup.shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun: contextCleanup.emitSubagentEndedHookForRun,
  emitSubagentProgressEndedForRun: emitSubagentProgressEndedHook,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
  retireSupersededRun: retireSupersededSubagentRun,
  resumeSubagentRun,
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
  clearScheduledResumeTimers,
  completeCleanupBookkeeping,
  completeSubagentRun,
  finalizeResumedAnnounceGiveUp,
  refreshFrozenResultFromSession,
  resumeRequesterSettleWake,
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

/** A drain refusal retries only while the same unfinished owner still holds the row. */
function retainsRetryAfterDrain(runId: string, entry: SubagentRunRecord): boolean {
  const current = subagentRuns.get(runId);
  return (
    isGatewayRestartDraining() &&
    isSameSubagentRunOwner(current, entry) &&
    typeof current?.cleanupCompletedAt !== "number"
  );
}

function scheduleSubagentDeliveryResumeRetry(
  runId: string,
  scheduledEntry: SubagentRunRecord,
  waitMs: number,
  stateContext = captureOpenClawStateWorkerContext(),
) {
  const resumeKey = getSubagentRunRuntimeKey(scheduledEntry);
  const timer = setTimeout(() => {
    resumeRetryTimers.delete(timer);
    void runWithGatewayDetachedWorkAdmission(async () => {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
      const current = subagentRuns.get(runId);
      if (!isSameSubagentRunOwner(current, scheduledEntry)) {
        resumedRuns.delete(resumeKey);
        return;
      }
      if (current?.cleanupHandled) {
        return;
      }
      resumedRuns.delete(resumeKey);
      resumeSubagentRun(runId);
    }, "subagents:resume-retry").catch((error: unknown) => {
      log.warn("failed to resume subagent delivery retry", { runId, error });
      const current = subagentRuns.get(runId);
      if (!isSameSubagentRunOwner(current, scheduledEntry)) {
        resumedRuns.delete(resumeKey);
        return;
      }
      if (current?.cleanupHandled) {
        return;
      }
      try {
        assertSubagentRegistryWriteSourceCurrent(stateContext);
      } catch {
        resumedRuns.delete(resumeKey);
        return;
      }
      if (retainsRetryAfterDrain(runId, scheduledEntry)) {
        scheduleSubagentDeliveryResumeRetry(
          runId,
          scheduledEntry,
          Math.max(waitMs, GATEWAY_ADMISSION_RETRY_DELAY_MS),
          stateContext,
        );
        return;
      }
      resumedRuns.delete(resumeKey);
    });
  }, waitMs);
  timer.unref?.();
  resumeRetryTimers.add(timer);
}

function finalizeResumedAnnounceGiveUpInBackground(
  runId: string,
  entry: SubagentRunRecord,
  reason: "expiry" | "permanent_failure",
) {
  const stateContext = captureOpenClawStateWorkerContext();
  const resumeKey = getSubagentRunRuntimeKey(entry);
  void runWithGatewayDetachedWorkAdmission(async () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    if (!isSameSubagentRunOwner(subagentRuns.get(runId), entry)) {
      resumedRuns.delete(resumeKey);
      return;
    }
    const current = subagentRuns.get(runId);
    if (current) {
      await finalizeResumedAnnounceGiveUp({ entry: current, reason, stateContext });
    }
  }, "subagents:delivery-finalize").catch((error: unknown) => {
    log.warn("failed to finalize exhausted subagent delivery", { runId, reason, error });
    try {
      assertSubagentRegistryWriteSourceCurrent(stateContext);
    } catch {
      return;
    }
    if (retainsRetryAfterDrain(runId, entry)) {
      scheduleSubagentDeliveryResumeRetry(
        runId,
        entry,
        GATEWAY_ADMISSION_RETRY_DELAY_MS,
        stateContext,
      );
      resumedRuns.add(resumeKey);
    }
  });
}

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
    // Startup orphan recovery replays this durable exact-run winner before it
    // reads session/config state. Do not prune or resume it through announce.
    resumedRuns.add(getSubagentRunRuntimeKey(entry));
    return;
  }
  const orphanReason = resolveSubagentRunOrphanReason({
    entry,
    includeStaleUnended: source === "restore",
  });
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
        },
        "orphan-resume",
      )
      .catch((error: unknown) => {
        log.warn("failed to settle orphaned subagent run", { runId, error });
      });
    return;
  }
  if (entry.killReconciliation) {
    const generation = entry.generation;
    resumedRuns.add(getSubagentRunRuntimeKey(entry));
    const stillCurrent = () =>
      isSameSubagentRunOwner(subagentRuns.get(runId), entry) && entry.generation === generation;
    const failed = (error: unknown) => {
      log.warn("subagent settlement deferred before cleanup", { runId, error });
      if (stillCurrent()) {
        resumedRuns.delete(getSubagentRunRuntimeKey(entry));
        scheduleSubagentDeliveryResumeRetry(runId, entry, GATEWAY_ADMISSION_RETRY_DELAY_MS);
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
        resumeFinalizedSubagentRun(runId, subagentRuns.get(runId)!, source);
      } catch (error) {
        failed(error);
      }
    }, "subagents:cancel-reconcile").catch(failed);
    return;
  }
  resumeFinalizedSubagentRun(runId, entry, source);
}

function resumeFinalizedSubagentRun(
  runId: string,
  entry: SubagentRunRecord,
  source: "live" | "restore",
) {
  const yieldedWakeWaitingForDelivery =
    entry.requesterSettleWake?.requesterYieldBatch === true &&
    (entry.delivery?.status === "pending" ||
      entry.delivery?.status === "in_progress" ||
      entry.delivery?.status === "failed");
  if (
    entry.requesterSettleWake &&
    typeof entry.execution.endedAt === "number" &&
    (!yieldedWakeWaitingForDelivery ||
      (entry.pauseReason === "sessions_yield" && entry.requesterSettleWake.pauseNotice))
  ) {
    resumeRequesterSettleWake(runId, entry, source);
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
    scheduleSubagentDeliveryResumeRetry(runId, entry, waitMs);
    resumedRuns.add(getSubagentRunRuntimeKey(entry));
    return;
  }

  if (typeof entry.execution.endedAt === "number" && entry.execution.endedAt > 0) {
    // Without a pending requester wake, the sweeper owns provisional cancellation cleanup.
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
  void subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs, entry, true);
  resumedRuns.add(getSubagentRunRuntimeKey(entry));
}

const subagentRestorer = createSubagentRegistryRestorer({
  runs: subagentRuns,
  getGatewayContextResolver: () => activeGatewayContextResolver,
  bindGatewayOwners: async () => {
    const lifecycleGatewayContextResolver = activeGatewayContextResolver;
    if (!lifecycleGatewayContextResolver?.()) {
      return false;
    }
    for (const entry of subagentRuns.values()) {
      const resolver = getGatewayContextResolver(entry);
      if (resolver) {
        if (entry.execution.status !== "terminal" || !entry.requesterSettleWake || resolver()) {
          continue;
        }
        const previousResumeKey = getSubagentRunRuntimeKey(entry);
        if (
          await recoverSubagentRunGatewayOwner(
            entry,
            lifecycleGatewayContextResolver,
            subagentLifecycleController.markRequesterSettleWakeRestored,
          )
        ) {
          resumedRuns.delete(previousResumeKey);
        }
        continue;
      }
      bindGatewayContextResolver(entry, lifecycleGatewayContextResolver);
      subagentRuns.commitOwnership(entry);
    }
    suspendReplacedNotificationsInBackground();
    return true;
  },
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
  retireSupersededRun: retireSupersededSubagentRun,
  ensureListener: () => subagentListener.ensure(),
  startSweeper: () => subagentSweeper.start(),
  scheduleSweep: scheduleSubagentRegistrySweep,
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
    !entry.requesterTurnRunId &&
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
  });
}

const subagentSweeper = createSubagentRegistrySweeper({
  runs: subagentRuns,
  resumedRuns,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  sweepPendingLifecycle: (now) => pendingLifecycle.sweepExpired(now),
  completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
  getGatewayRecoveryRuntime: () => activeGatewayContextResolver?.()?.recoveryRuntime,
  finalizeInterruptedSubagentRun: completionRuntime.finalizeInterruptedSubagentRun,
  resumeRequesterSettleWake,
  startSubagentAnnounceCleanupFlow,
  completeCleanupBookkeeping,
  isCleanupOwnerCurrent: subagentLifecycleController.isCleanupOwnerCurrent,
  sessionEffectsHostCurrent: (entry) =>
    subagentLifecycleController.sessionEffectsHostCurrent(entry),
  shouldSuppressSessionEffects: (entry, effects) =>
    subagentLifecycleController.shouldSuppressSessionEffects(entry, effects),
  discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
  shouldEmitEndedHookForRun: contextCleanup.shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun: contextCleanup.emitSubagentEndedHookForRun,
  callGateway: callSubagentRegistryGateway,
  cleanupCollectorLaunchResources: contextCleanup.cleanupCollectorLaunchResources,
  runContextEngineSubagentEnded: contextCleanup.runContextEngineSubagentEnded,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
  retireSupersededRun: retireSupersededSubagentRun,
  getRunsForChildSession: getSubagentRunsForChildSession,
  getRunsForCollectorGroup: getSubagentRunsForCollectorGroup,
  warn,
});

const subagentListener = createSubagentRegistryListener({
  runs: subagentRuns,
  pendingLifecycle,
  onAgentEvent,
  resumeRequesterSettleWake,
  adoptPausedSubagentRunIntoSuccessor: (entry) =>
    subagentRunManager.adoptPausedSubagentRunIntoSuccessor({
      childSessionKey: entry.childSessionKey,
      childAgentId: entry.childAgentId,
    }),
  refreshFrozenResultFromSession,
  completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
  warn,
});

const subagentRunManager = createSubagentRunManager({
  acquireTerminalCompletionLock: (runId) =>
    subagentLifecycleController.acquireTerminalCompletionLock(runId),
  runs: subagentRuns,
  getRunsForChildSession: getSubagentRunsForChildSession,
  resumedRuns,
  callGateway: async <T>(request: Parameters<typeof callGateway>[0]) => {
    if (request.method === "agent.wait") {
      const gatewayRuntime = activeGatewayContextResolver?.()?.recoveryRuntime;
      if (gatewayRuntime) {
        // Registry waits are Gateway-owned lifecycle work. Keep them on the
        // owning instance when one exists; standalone processes authenticate normally.
        return await gatewayRuntime.waitForAgent<T>(
          (request.params ?? {}) as AgentWaitParams,
          request.timeoutMs ?? undefined,
        );
      }
    }
    return await callSubagentRegistryGateway<T>(request);
  },
  getRuntimeConfig,
  ensureListener: subagentListener.ensure,
  startSweeper: subagentSweeper.start,
  stopSweeper: subagentSweeper.stop,
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
  clearScheduledResumeTimers();
  for (const timer of resumeRetryTimers) {
    clearTimeout(timer);
  }
  resumeRetryTimers.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  pendingLifecycle.clearAll();
  resetSubagentRegistryRuntimeLoadersForTests();
  contextCleanup.reset();
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

async function addSubagentRunForTests(entry: SubagentRunRecord) {
  await mutateSubagentRuns([entry.runId], () => ({
    value: undefined,
    postimages: new Map([[entry.runId, entry]]),
  }));
}

export const finalizeInterruptedSubagentRun = completionRuntime.finalizeInterruptedSubagentRun;
export const markSubagentRunTerminated = subagentRunManager.markSubagentRunTerminated;
export const cancelSubagentRequesterSettleWake =
  subagentLifecycleController.cancelRequesterSettleWake;

export { prependAgentSteeringPrompt };

const publicApi = createSubagentRegistryPublicApi({
  runs: subagentRuns,
  restoreOnce: (context) => subagentRestorer.restoreOnce(undefined, true, context),
  startAnnounceCleanup: startSubagentAnnounceCleanupFlow,
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
  markRequesterYielded: subagentLifecycleController.markRequesterTurnYielded,
});

export const leasePendingAgentSteeringItems = publicApi.leasePendingAgentSteeringItems;
export const ackPendingAgentSteeringItems = publicApi.ackPendingAgentSteeringItems;
export const releasePendingAgentSteeringItems = publicApi.releasePendingAgentSteeringItems;
export const getSubagentRunByRunId = publicApi.getSubagentRunByRunId;
export const prepareSubagentRunsByRunIds = publicApi.prepareSubagentRunsByRunIds;
export const completeCollectorLaunchCleanup = publicApi.completeCollectorLaunchCleanup;
export const recordSwarmStructuredOutput = publicApi.recordSwarmStructuredOutput;
export const listSwarmRunsForGroup = publicApi.listSwarmRunsForGroup;
export const getSwarmRunByLaunchReplayKey = publicApi.getSwarmRunByLaunchReplayKey;
export const countActiveRunsForSession = publicApi.countActiveRunsForSession;
export function initSubagentRegistry() {
  return subagentRestorer.restoreOnce();
}
export function activateSubagentRegistry(resolveGatewayContext: GatewayContextResolver) {
  // Reuse the instance's own fenced closure so late-restored siblings share one
  // authority across repeated activation; the raw holder can outlive that instance.
  activeGatewayContextResolver = resolveGatewayContext()?.resolveGatewayContext;
  return subagentRestorer.activate();
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
    addSubagentRunForTests,
    finalizeInterruptedSubagentRun: completionRuntime.finalizeInterruptedSubagentRun,
    releaseSubagentRun: subagentRunManager.releaseSubagentRun,
    resetSubagentRegistryForTests,
    testing,
  };
}

// Register the subagent maintenance preserve-key provider as a module side effect.
import "./subagent-registry-maintenance.js";
