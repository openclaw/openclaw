import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import {
  isSystemEventStoreCurrent,
  recordSystemEventStoreReplaced,
} from "../../../infra/system-event-ownership.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { recordSubagentTerminalState } from "../../../sessions/subagent-terminal-state.js";
import { retireSessionMcpRuntimeForSessionKey } from "../../agent-bundle-mcp-tools.js";
import { withoutGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import { blockSubagentCompletionDelivery } from "../completion/subagent-completion-admission.store.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { getDeliveryLastError, isDeliverySuspended } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  logAnnounceGiveUp,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import type {
  SubagentLifecycleAnnounceCleanupContext,
  SubagentLifecycleCleanupContext,
  SubagentLifecycleCommonContext,
  SubagentLifecycleCompletionContext,
  SubagentLifecycleOptions,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  buildSafeLifecycleErrorMeta,
  maskLifecycleIdentifier,
} from "./subagent-registry-lifecycle-delivery.js";
import { scheduleRequesterSettleWake } from "./subagent-registry-lifecycle-wake.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

const MAX_DETACHED_CLEANUP_RETRIES = 3;
const pendingStoreRetirements = new WeakMap<SubagentRunRecord, Promise<void>>();
type BrowserCleanup = typeof cleanupBrowserSessionsForLifecycleEnd;

function runWithSubagentCleanupWorkAdmission<T>(run: () => Promise<T>): Promise<T> {
  // Restart remains one-way; only suspension preserves an admitted cleanup owner.
  // The registry owns cleanup after the spawning tool's caller has retired.
  return withoutGatewayToolCallerIdentity(() =>
    isGatewayRestartDraining()
      ? runWithGatewayIndependentRootWorkAdmission(run, "subagents:lifecycle-cleanup")
      : runWithGatewayIndependentRootWorkContinuation(run, "subagents:lifecycle-cleanup"),
  );
}

export function scheduleResumeSubagentRun(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  delayMs: number,
  cleanupGeneration?: number,
): void {
  const params = context.options;
  const timer = setTimeout(() => {
    context.deleteScheduledResumeTimer(timer);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (params.runs.get(runId) !== entry) {
        return;
      }
      if (cleanupGeneration !== undefined) {
        if (!context.isCleanupGenerationCurrent(runId, entry, cleanupGeneration)) {
          return;
        }
        if (entry.cleanupHandled) {
          entry.cleanupHandled = false;
          params.persist(runId);
        }
      }
      params.resumedRuns.delete(runId);
      params.resumeSubagentRun(runId);
    }, "subagents:resume").catch((err: unknown) => {
      defaultRuntime.log(`[warn] subagent cleanup resume failed (${runId}): ${String(err)}`);
      const current = params.runs.get(runId);
      if (
        isGatewayRestartDraining() &&
        current === entry &&
        typeof current.cleanupCompletedAt !== "number"
      ) {
        scheduleResumeSubagentRun(
          context,
          runId,
          entry,
          Math.max(delayMs, MIN_ANNOUNCE_RETRY_DELAY_MS),
          cleanupGeneration,
        );
      }
    });
  }, delayMs);
  timer.unref?.();
  context.addScheduledResumeTimer(timer);
}

export function runDetachedCleanupAttempt(
  context: SubagentLifecycleCleanupContext,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    cleanupGeneration: number;
    run: () => Promise<void>;
  },
): void {
  const params = context.options;
  // Completion makes the task projection non-blocking before delivery and
  // cleanup finish. This independent lease bridges that handoff and owns the
  // full detached attempt, including its final durable registry write.
  // Completion outlives the spawning attempt; inherited lock owners would
  // reject requester transcript writes after that attempt is disposed.
  runWithoutOwnedSessionTranscriptWrites(() => {
    void runWithSubagentCleanupWorkAdmission(async () => {
      try {
        await args.run();
        context.clearCleanupFailureCount(args.entry);
      } catch (err) {
        defaultRuntime.log(
          `[warn] subagent cleanup finalize failed (${args.runId}): ${String(err)}`,
        );
        const current = params.runs.get(args.runId);
        if (
          !current ||
          current.cleanupCompletedAt ||
          !context.isCleanupAttemptCurrent(args.runId, args.entry, args.cleanupGeneration)
        ) {
          return;
        }
        current.cleanupHandled = false;
        params.resumedRuns.delete(args.runId);
        params.persist(args.runId);
        const failureCount = context.incrementCleanupFailureCount(current);
        if (failureCount <= MAX_DETACHED_CLEANUP_RETRIES) {
          scheduleResumeSubagentRun(
            context,
            args.runId,
            current,
            resolveAnnounceRetryDelayMs(failureCount),
            args.cleanupGeneration,
          );
        }
      }
    }).catch((err: unknown) => {
      defaultRuntime.log(
        `[warn] subagent cleanup admission failed (${args.runId}): ${String(err)}`,
      );
      if (isGatewayRestartDraining()) {
        scheduleResumeSubagentRun(
          context,
          args.runId,
          args.entry,
          MIN_ANNOUNCE_RETRY_DELAY_MS,
          args.cleanupGeneration,
        );
      }
    });
  });
}

export async function suspendPendingFinalDelivery(
  context: SubagentLifecycleCleanupContext & SubagentLifecycleWakeContext,
  args: {
    runId: string;
    entry: SubagentRunRecord;
    reason: "expiry" | "permanent_failure";
    error?: string;
    enqueuedAt?: number;
    lastDropReason?: NonNullable<SubagentRunRecord["delivery"]>["lastDropReason"];
    storeReplaced?: true;
  },
): Promise<void> {
  const params = context.options;
  const generation = args.entry.generation;
  const committed = await blockSubagentCompletionDelivery({
    subagent: args.entry,
    reason: args.error ?? getDeliveryLastError(args.entry) ?? args.reason,
    suspendedReason: args.reason,
    lastDropReason: args.lastDropReason ?? args.entry.delivery?.lastDropReason,
    enqueuedAt: args.enqueuedAt,
    storeReplaced: args.storeReplaced,
  });
  if (!committed) {
    throw new Error(`subagent completion owner changed before suspension: ${args.runId}`);
  }
  if (params.runs.get(args.runId) !== args.entry || args.entry.generation !== generation) {
    return;
  }
  params.resumedRuns.delete(args.runId);
  if (args.entry.delivery?.discardReason === "task-missing") {
    return;
  }
  logAnnounceGiveUp(args.entry, args.reason);
  // Suspension settles this child for requester drain while cleanup stays incomplete.
  scheduleRequesterSettleWake(context, args.runId, args.entry);
}

export function isSubagentCompletionDeliveryAllowed(
  context: SubagentLifecycleAnnounceCleanupContext,
  entry: SubagentRunRecord,
  cleanupGeneration: number,
  committedDelivery: SubagentRunRecord["delivery"],
): boolean {
  const { runId, requesterSessionKey, requesterStorePath, requesterAgentId } = entry;
  const allowed =
    !subagentRuns.isCompletionAuthorityRetired(entry) &&
    entry.suppressCompletionDelivery !== true &&
    !isDeliverySuspended(entry) &&
    (entry.delivery?.status !== "delivered" || entry.delivery === committedDelivery) &&
    context.isCleanupAttemptCurrent(runId, entry, cleanupGeneration);
  if (
    !allowed ||
    isSystemEventStoreCurrent(requesterSessionKey, requesterStorePath, requesterAgentId)
  ) {
    return allowed;
  }
  if (entry.expectsCompletionMessage === true) {
    subagentRuns.retireCompletionAuthority(entry);
  }
  return false;
}

export function suspendReplacedStoreNotifications(
  options: SubagentLifecycleOptions,
): Promise<void> {
  // Capture retirement before yielding: restoring the old selector cannot revive these notifications.
  const pending = new Set<Promise<void>>();
  const entries = [...options.runs.values()]
    .filter((entry) => {
      const work = pendingStoreRetirements.get(entry);
      if (!work) {
        return true;
      }
      pending.add(work);
      return false;
    })
    .filter((entry) => {
      const { delivery, requesterSessionKey, requesterStorePath, requesterAgentId } = entry;
      return (
        delivery &&
        ["pending", "in_progress"].includes(delivery.status) &&
        delivery.deliveredAt === undefined &&
        delivery.announcedAt === undefined &&
        entry.execution.status === "terminal" &&
        entry.expectsCompletionMessage === true &&
        !isSystemEventStoreCurrent(requesterSessionKey, requesterStorePath, requesterAgentId)
      );
    })
    .map((entry) => ({
      entry,
      generation: entry.generation,
      deliveryGeneration: entry.delivery?.generation,
    }));
  if (!entries.length) {
    return Promise.all(pending).then(() => {});
  }
  entries.forEach(({ entry }) => subagentRuns.retireCompletionAuthority(entry));
  const work = runWithSubagentCleanupWorkAdmission(async () => {
    for (const { entry, generation, deliveryGeneration } of entries) {
      if (
        options.runs.get(entry.runId) !== entry ||
        entry.generation !== generation ||
        entry.delivery?.generation !== deliveryGeneration
      ) {
        continue;
      }
      if (
        !(await blockSubagentCompletionDelivery({
          subagent: entry,
          reason: "store replaced",
          suspendedReason: "permanent_failure",
          storeReplaced: true,
        }))
      ) {
        options.warn("subagent notification store retirement has no current native owner", {
          runId: entry.runId,
        });
        continue;
      }
      if (
        options.runs.get(entry.runId) !== entry ||
        entry.generation !== generation ||
        entry.delivery?.generation !== deliveryGeneration
      ) {
        continue;
      }
      options.resumedRuns.delete(entry.runId);
      recordSystemEventStoreReplaced();
    }
  }).finally(() => {
    for (const { entry } of entries) {
      pendingStoreRetirements.delete(entry);
    }
  });
  for (const { entry } of entries) {
    pendingStoreRetirements.set(entry, work);
  }
  pending.add(work);
  return Promise.all(pending).then(() => {});
}

export function beginSubagentCleanup(
  context: SubagentLifecycleCleanupContext,
  runId: string,
): number | undefined {
  const params = context.options;
  const entry = params.runs.get(runId);
  if (!entry || entry.cleanupCompletedAt || entry.cleanupHandled) {
    return undefined;
  }
  entry.cleanupHandled = true;
  const generation = context.bumpCleanupGeneration(entry);
  params.persist(runId);
  return generation;
}

export async function retireSupersededCleanupIfNeeded(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): Promise<boolean> {
  const params = context.options;
  if (
    params.runs.get(runId) !== entry ||
    !context.isCleanupGeneration(entry, generation) ||
    !context.newerGenerationOwnsSession(entry)
  ) {
    return false;
  }
  // Cleanup can yield to attachment, mirror, or announce work. A successor
  // registered while it was suspended owns every session-scoped side effect.
  await params.retireSupersededRun(runId, entry);
  return true;
}

export function retireSupersededCleanupInBackground(
  context: SubagentLifecycleCleanupContext,
  runId: string,
  entry: SubagentRunRecord,
  generation: number,
): void {
  // Delivery callbacks are synchronous and may arrive after their announce
  // attempt returns. Give the async retirement tail its own snapshot blocker.
  void runWithSubagentCleanupWorkAdmission(async () => {
    await retireSupersededCleanupIfNeeded(context, runId, entry, generation);
  }).catch((error: unknown) => {
    defaultRuntime.log(
      `[warn] subagent superseded cleanup retirement failed (${runId}): ${String(error)}`,
    );
  });
}

async function retireRunModeBundleMcpRuntime(
  context: SubagentLifecycleCommonContext,
  cleanupParams: { runId: string; entry: SubagentRunRecord; reason: string },
): Promise<void> {
  const params = context.options;
  if (cleanupParams.entry.spawnMode === "session") {
    return;
  }
  await retireSessionMcpRuntimeForSessionKey({
    sessionKey: cleanupParams.entry.childSessionKey,
    reason: cleanupParams.reason,
    preserveActiveLeases: true,
    onError: (error, sessionId) => {
      params.warn("failed to retire subagent bundle MCP runtime", {
        error: buildSafeLifecycleErrorMeta(error),
        sessionId,
        runId: maskLifecycleIdentifier(cleanupParams.runId, "run"),
        childSessionKey: maskLifecycleIdentifier(cleanupParams.entry.childSessionKey, "session"),
      });
    },
  });
}

export async function completeTerminalEffects(
  context: SubagentLifecycleCompletionContext,
  args: {
    completeParams: SubagentCompletionRequest;
    completionReason: SubagentLifecycleEndedReason;
    entry: SubagentRunRecord;
    mutated: boolean;
    sessionSuperseded: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup>;
  },
): Promise<void> {
  const params = context.options;
  const { completeParams, completionReason, entry, mutated, terminalGeneration } = args;
  let { sessionSuperseded, suppressSessionEffects } = args;
  const isCurrentTerminalCallback = () =>
    context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration);
  const isCurrentSessionEffectsOwner = () =>
    isCurrentTerminalCallback() &&
    !context.newerGenerationOwnsSession(entry) &&
    !context.shouldSuppressSessionEffects(entry);
  const refreshSessionEffectsSuppression = () => {
    if (!context.shouldSuppressSessionEffects(entry)) {
      return false;
    }
    suppressSessionEffects = true;
    if (entry.execution.suppressSessionEffects !== true) {
      const previousExecution = entry.execution;
      entry.execution = { ...entry.execution, suppressSessionEffects: true };
      try {
        params.persistOrThrow(completeParams.runId);
      } catch (error) {
        entry.execution = previousExecution;
        suppressSessionEffects = false;
        throw error;
      }
    }
    return true;
  };
  if (!isCurrentTerminalCallback()) {
    return;
  }
  const retireSupersededSession = async (currentEntry: SubagentRunRecord) => {
    if (completionReason !== SUBAGENT_ENDED_REASON_KILLED) {
      await params.retireSupersededRun(completeParams.runId, currentEntry);
    }
  };
  sessionSuperseded ||= context.newerGenerationOwnsSession(entry);
  if (sessionSuperseded) {
    // This callback belongs to an older run that shared the session key.
    // Update only its task projection; the newer generation owns all session effects.
    await retireSupersededSession(entry);
    return;
  }
  if (entry.collect) {
    releaseSwarmRun(entry.schedulerSlotId ?? entry.runId);
  }
  refreshSessionEffectsSuppression();
  // Record only the current, non-superseded callback with a committed outcome; the
  // run-terminal dedupe key is first-write-wins, so a provisional/stale status here
  // would permanently mislabel the signal-log terminal kind.
  const terminalOutcome = entry.execution.outcome;
  const outcomeStatus = terminalOutcome?.status;
  if (
    !suppressSessionEffects &&
    entry.killReconciliation === undefined &&
    outcomeStatus &&
    outcomeStatus !== "unknown"
  ) {
    const signal = {
      childSessionKey: entry.childSessionKey,
      runId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      outcomeStatus,
    };
    const terminalEndedAt = entry.execution.endedAt;
    const hasCurrentTerminalOutcome = () =>
      entry.killReconciliation === undefined &&
      entry.execution.status === "terminal" &&
      entry.execution.outcome === terminalOutcome &&
      entry.execution.outcome?.status === outcomeStatus &&
      entry.execution.endedAt === terminalEndedAt &&
      entry.runId === signal.runId &&
      entry.childSessionKey === signal.childSessionKey &&
      entry.requesterSessionKey === signal.requesterSessionKey;
    await recordSubagentTerminalState(signal, () => {
      if (!isCurrentSessionEffectsOwner() || !hasCurrentTerminalOutcome()) {
        throw new Error("Subagent terminal signal owner changed before commit");
      }
    });
    if (!isCurrentTerminalCallback()) {
      return;
    }
    refreshSessionEffectsSuppression();
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
    if (!hasCurrentTerminalOutcome()) {
      return;
    }
  }
  const isProvisionalKill = entry.killReconciliation !== undefined;

  if (!suppressSessionEffects) {
    try {
      const assertSessionEffectsOwnerCurrent = () => {
        if (!isCurrentSessionEffectsOwner()) {
          throw new Error("subagent session-effects owner retired before session commit");
        }
      };
      await persistSubagentSessionTiming(entry, {
        // Recheck while patchSessionEntry owns its write lock so this old
        // completion cannot commit after a synchronous ownership transfer.
        isCurrentGeneration: isCurrentSessionEffectsOwner,
        assertCommitAllowed: assertSessionEffectsOwnerCurrent,
      });
    } catch (err) {
      params.warn("failed to persist subagent session timing", {
        err,
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
      });
    }
  }
  refreshSessionEffectsSuppression();
  if (!isCurrentTerminalCallback()) {
    return;
  }
  if (context.newerGenerationOwnsSession(entry)) {
    await retireSupersededSession(entry);
    return;
  }

  const suppressedForSteerRestart = params.suppressAnnounceForSteerRestart(entry);
  // Recovery persists its terminal state before draining this callback, so an
  // unchanged row still needs its first session-status and progress events.
  const shouldPublishTerminalStatus =
    mutated ||
    (completeParams.recoverInterrupted === true &&
      !isProvisionalKill &&
      !context.hasProgressEnded(entry));
  if (shouldPublishTerminalStatus && !suppressedForSteerRestart && !suppressSessionEffects) {
    emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
    // The enclosing steer/session-effects guard admits only the real terminal generation.
    if (!isProvisionalKill && !context.hasProgressEnded(entry)) {
      context.markProgressEnded(entry);
      await params.emitSubagentProgressEndedForRun(entry);
      refreshSessionEffectsSuppression();
      if (!isCurrentTerminalCallback()) {
        return;
      }
    }
  }
  const shouldEmitEndedHook =
    !suppressedForSteerRestart &&
    !isProvisionalKill &&
    !suppressSessionEffects &&
    params.shouldEmitEndedHookForRun({ entry, reason: completionReason });
  const shouldDeferEndedHook =
    shouldEmitEndedHook && completeParams.triggerCleanup && entry.expectsCompletionMessage === true;
  if (!shouldDeferEndedHook && shouldEmitEndedHook) {
    await params.emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: completeParams.sendFarewell,
      accountId: completeParams.accountId,
      isCurrent: isCurrentSessionEffectsOwner,
    });
    refreshSessionEffectsSuppression();
    if (!isCurrentTerminalCallback()) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
  }

  refreshSessionEffectsSuppression();
  await completeTerminalCleanup(context, {
    completeParams,
    entry,
    isProvisionalKill,
    retireSupersededSession,
    suppressedForSteerRestart,
    suppressSessionEffects,
    terminalGeneration,
    loadCleanupBrowserSessionsForLifecycleEnd: () =>
      args.loadCleanupBrowserSessionsForLifecycleEnd(),
  });
}

async function completeTerminalCleanup(
  context: SubagentLifecycleCompletionContext,
  args: {
    completeParams: SubagentCompletionRequest;
    entry: SubagentRunRecord;
    isProvisionalKill: boolean;
    retireSupersededSession: (entry: SubagentRunRecord) => Promise<void>;
    suppressedForSteerRestart: boolean;
    suppressSessionEffects: boolean;
    terminalGeneration: number;
    loadCleanupBrowserSessionsForLifecycleEnd(): Promise<BrowserCleanup>;
  },
): Promise<void> {
  const params = context.options;
  const {
    completeParams,
    entry,
    isProvisionalKill,
    retireSupersededSession,
    suppressedForSteerRestart,
    terminalGeneration,
  } = args;
  let { suppressSessionEffects } = args;
  // Session cleanup belongs to the exact registry row and child generation.
  // A replacement may reuse either the run id or the child session key.
  const isSessionEffectsOwnerCurrent = () =>
    context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration) &&
    !context.newerGenerationOwnsSession(entry);
  const refreshSessionEffectsSuppression = () => {
    if (
      suppressSessionEffects ||
      !isSessionEffectsOwnerCurrent() ||
      !context.shouldSuppressSessionEffects(entry)
    ) {
      return suppressSessionEffects;
    }
    const previousExecution = entry.execution;
    entry.execution = { ...previousExecution, suppressSessionEffects: true };
    try {
      params.persistOrThrow(completeParams.runId);
    } catch (error) {
      entry.execution = previousExecution;
      throw error;
    }
    suppressSessionEffects = true;
    return true;
  };
  if (!completeParams.triggerCleanup || suppressedForSteerRestart) {
    return;
  }

  refreshSessionEffectsSuppression();
  if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
    return;
  }
  if (context.newerGenerationOwnsSession(entry)) {
    await retireSupersededSession(entry);
    return;
  }

  // registerSubagentRun fires both an in-process listener and a gateway
  // waitForSubagentCompletion RPC; both can reach this point for the same
  // runId in embedded mode. Dedupe only the browser driver tab-close IPC
  // with a sync check-then-set. The retire + announce tail below must still
  // run for every caller, so a slow or held first browser cleanup cannot
  // strand a duplicate caller's completion behind it.
  if (!suppressSessionEffects && entry.browserCleanupDispatchedAt === undefined) {
    let dispatchedBrowserCleanup = false;
    let cleanupBrowserSessions: typeof cleanupBrowserSessionsForLifecycleEnd | undefined =
      params.cleanupBrowserSessionsForLifecycleEnd;
    try {
      cleanupBrowserSessions ??= await args.loadCleanupBrowserSessionsForLifecycleEnd();
    } catch (error) {
      params.warn("failed to load browser cleanup for completed subagent", {
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskLifecycleIdentifier(completeParams.runId, "run"),
        childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
      });
    }
    if (cleanupBrowserSessions) {
      if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      if (context.newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
      // Claim only when this caller is about to dispatch. A concurrent caller
      // may have claimed while the lazy browser module was loading.
      if (!refreshSessionEffectsSuppression() && entry.browserCleanupDispatchedAt === undefined) {
        entry.browserCleanupDispatchedAt = Date.now();
        dispatchedBrowserCleanup = true;
        try {
          await cleanupBrowserSessions({
            sessionKeys: [entry.childSessionKey],
            isCurrent: () =>
              isSessionEffectsOwnerCurrent() && !context.shouldSuppressSessionEffects(entry),
            onWarn: (msg) => params.warn(msg, { runId: entry.runId }),
          });
        } catch (error) {
          params.warn("failed to cleanup browser sessions for completed subagent", {
            error: buildSafeLifecycleErrorMeta(error),
            runId: maskLifecycleIdentifier(completeParams.runId, "run"),
            childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
          });
        }
      }
    }
    if (dispatchedBrowserCleanup) {
      if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
        return;
      }
      refreshSessionEffectsSuppression();
      if (context.newerGenerationOwnsSession(entry)) {
        await retireSupersededSession(entry);
        return;
      }
    }
  }

  if (!suppressSessionEffects) {
    if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
    try {
      await retireRunModeBundleMcpRuntime(context, {
        runId: completeParams.runId,
        entry,
        reason: "subagent-run-complete",
      });
    } catch (error) {
      params.warn("failed to retire subagent bundle MCP runtime after completion", {
        error: buildSafeLifecycleErrorMeta(error),
        runId: maskLifecycleIdentifier(completeParams.runId, "run"),
        childSessionKey: maskLifecycleIdentifier(entry.childSessionKey, "session"),
      });
    }
    if (!context.isTerminalCallbackCurrent(completeParams.runId, entry, terminalGeneration)) {
      return;
    }
    refreshSessionEffectsSuppression();
    if (context.newerGenerationOwnsSession(entry)) {
      await retireSupersededSession(entry);
      return;
    }
  }

  if (isProvisionalKill) {
    // Browser and MCP resources can close immediately, but completion delivery
    // waits for the provider result or the killed tombstone reconciliation.
    return;
  }

  refreshSessionEffectsSuppression();
  context.startSubagentAnnounceCleanupFlow(completeParams.runId, entry);
}
