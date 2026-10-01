import pLimit from "p-limit";
import type { ProgressContinuationState } from "../../../channels/progress-continuation.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  runWithGatewayDetachedWorkContinuation,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import {
  prepareRequesterCronAuthority,
  type PreparedRequesterCronAuthority,
} from "../requester-cron-authority.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
} from "./subagent-delivery-state.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import {
  resumeAncestorCleanup,
  startSubagentAnnounceCleanupFlow,
} from "./subagent-registry-lifecycle-announce-cleanup.js";
import { completeCleanupBookkeeping } from "./subagent-registry-lifecycle-bookkeeping.js";
import { completeSubagentRunAttempt } from "./subagent-registry-lifecycle-completion.js";
import type {
  CleanupBookkeepingParams,
  PendingRequesterSettleWakeCommit,
  ScheduledRequesterSettleWake,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle-context.js";
import { refreshFrozenResultFromSession } from "./subagent-registry-lifecycle-delivery.js";
import { finalizeResumedAnnounceGiveUp } from "./subagent-registry-lifecycle-give-up.js";
import {
  cancelRequesterSettleWake,
  scheduleRequesterSettleWake,
} from "./subagent-registry-lifecycle-wake.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { assertSubagentRegistryWriteSourceCurrent } from "./subagent-registry-persistence.js";
import { commitRequesterInitialTransfer } from "./subagent-registry-requester-wake-commit.js";
import {
  adoptSubagentRunForRequesterTurnInRuns,
  markRequesterTurnYieldedInRuns,
  settleRequesterTurnAfterSessionSpawns,
  type RequesterInitialTransfer,
} from "./subagent-registry-requester-yield.js";
import type {
  SubagentCompletionRequest,
  SubagentRunRecord,
  SubagentSessionEffects,
} from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";

// Restored rows can arrive in a large burst. Limit only that startup catch-up
// so ordinary live settles keep their existing latency and concurrency.
const RESTORED_REQUESTER_SETTLE_WAKE_CONCURRENCY = 2;

export class SubagentLifecycleController {
  readonly pendingRequesterSettleWakeCommits = new WeakMap<
    SubagentRunRecord,
    PendingRequesterSettleWakeCommit
  >();
  readonly scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();
  pendingRequesterSettleWakeRearms = new WeakSet<SubagentRunRecord>();
  readonly scheduledRequesterSettleWakeRuns = new WeakSet<SubagentRunRecord>();
  private readonly restoredRequesterSettleWakeRuns = new Set<string>();
  private readonly restoredRequesterSettleWakeLimits = new WeakMap<
    object,
    ReturnType<typeof pLimit>
  >();
  readonly scheduledRequesterSettleWakeTimers = new Map<string, ScheduledRequesterSettleWake>();
  private readonly terminalCompletionLocks = new Map<string, Promise<void>>();
  private readonly terminalGenerations = new WeakMap<SubagentRunRecord, number>();
  private readonly terminalSessionEffects = new WeakMap<
    SubagentRunRecord,
    SubagentSessionEffects
  >();
  private readonly cleanupGenerations = new WeakMap<SubagentRunRecord, number>();
  readonly progressEndedEntries = new WeakSet<SubagentRunRecord>();
  readonly cleanupFailureCounts = new WeakMap<SubagentRunRecord, number>();

  constructor(readonly options: SubagentLifecycleOptions) {}

  newerGenerationOwnsSession(entry: SubagentRunRecord): boolean {
    if (entry.killReconciliation?.supersededAt !== undefined) {
      return true;
    }
    const latest = this.options.getLatestRunForChildSession(
      entry.childSessionKey,
      (candidate) => candidate.runId !== entry.runId,
    );
    return latest !== null && compareSubagentRunGeneration(latest, entry) > 0;
  }

  bindTerminalSessionEffects(entry: SubagentRunRecord, effects?: SubagentSessionEffects): void {
    if (effects) {
      this.terminalSessionEffects.set(entry, effects);
    }
  }

  async shouldSuppressSessionEffects(
    entry: SubagentRunRecord,
    prospectiveEffects?: SubagentSessionEffects,
  ): Promise<boolean> {
    const boundEffects = this.terminalSessionEffects.get(entry);
    const effects = prospectiveEffects ?? boundEffects;
    return (
      shouldSuppressSubagentRecoverySessionEffects(entry) ||
      (await effects?.isCurrent()) === false ||
      this.terminalSessionEffects.get(entry) !== boundEffects ||
      shouldSuppressSubagentRecoverySessionEffects(entry)
    );
  }

  sessionEffectsHostCurrent(entry: SubagentRunRecord): boolean {
    if (shouldSuppressSubagentRecoverySessionEffects(entry)) {
      return false;
    }
    try {
      this.terminalSessionEffects.get(entry)?.assertHostCurrent();
      return true;
    } catch {
      return false;
    }
  }

  getSessionEffects(entry: SubagentRunRecord): SubagentSessionEffects | undefined {
    return this.terminalSessionEffects.get(entry);
  }

  async acquireTerminalCompletionLock(runId: string): Promise<() => void> {
    const previous = this.terminalCompletionLocks.get(runId) ?? Promise.resolve();
    const { promise: current, resolve: releaseLock } = createDeferredCore();
    this.terminalCompletionLocks.set(runId, current);
    await previous;
    return () => {
      releaseLock();
      if (this.terminalCompletionLocks.get(runId) === current) {
        this.terminalCompletionLocks.delete(runId);
      }
    };
  }

  /** The reset owner calls this synchronously before publishing another session generation. */
  revokeTerminalSessionEffects(entries: Iterable<SubagentRunRecord>): void {
    const previous = new Map<SubagentRunRecord, SubagentRunRecord["execution"]>();
    for (const entry of entries) {
      if (this.options.runs.get(entry.runId) !== entry) {
        continue;
      }
      // A capture may have staged terminal state and still own rollback. Reset
      // must not persist that tentative result or let its rollback erase revocation.
      if (this.terminalCompletionLocks.has(entry.runId)) {
        throw new Error("Subagent completion is still settling; retry the session reset.");
      }
      // Even an already-set flag may come from a failed best-effort sweep write.
      if (entry.execution.status === "terminal" && entry.pauseReason !== "sessions_yield") {
        previous.set(entry, entry.execution);
      }
    }
    if (previous.size === 0) {
      return;
    }
    for (const [entry, execution] of previous) {
      entry.execution = { ...execution, suppressSessionEffects: true };
    }
    try {
      this.options.persistOrThrow(...[...previous.keys()].map((entry) => entry.runId));
    } catch (error) {
      for (const [entry, execution] of previous) {
        entry.execution = execution;
      }
      throw error;
    }
  }

  clearScheduledResumeTimers = () => {
    for (const timer of this.scheduledResumeTimers) {
      clearTimeout(timer);
    }
    this.scheduledResumeTimers.clear();
    for (const scheduled of this.scheduledRequesterSettleWakeTimers.values()) {
      clearTimeout(scheduled.timer);
      this.pendingRequesterSettleWakeCommits.get(scheduled.entry)?.initialTransfer?.retire();
    }
    for (const entry of this.options.runs.values()) {
      this.pendingRequesterSettleWakeCommits.get(entry)?.initialTransfer?.retire();
    }
    this.scheduledRequesterSettleWakeTimers.clear();
    this.pendingRequesterSettleWakeRearms = new WeakSet();
  };

  bumpCleanupGeneration(entry: SubagentRunRecord): number {
    const generation = (this.cleanupGenerations.get(entry) ?? 0) + 1;
    this.cleanupGenerations.set(entry, generation);
    return generation;
  }

  isCleanupGeneration = (entry: SubagentRunRecord, generation: number): boolean =>
    this.cleanupGenerations.get(entry) === generation;
  isCleanupGenerationCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    this.options.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    this.isCleanupGeneration(entry, generation) &&
    !this.newerGenerationOwnsSession(entry);
  isCleanupAttemptCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    entry.cleanupHandled === true && this.isCleanupGenerationCurrent(runId, entry, generation);
  isEndedHookOwnerCurrent = (runId: string, entry: SubagentRunRecord): boolean => {
    const current = this.options.runs.get(runId);
    return (
      (current === undefined || current === entry) &&
      entry.pauseReason !== "sessions_yield" &&
      !this.newerGenerationOwnsSession(entry)
    );
  };

  bumpTerminalGeneration(entry: SubagentRunRecord): number {
    const generation = (this.terminalGenerations.get(entry) ?? 0) + 1;
    this.terminalGenerations.set(entry, generation);
    return generation;
  }

  isTerminalCallbackCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    this.options.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    this.terminalGenerations.get(entry) === generation;
  incrementCleanupFailureCount(entry: SubagentRunRecord): number {
    const count = (this.cleanupFailureCounts.get(entry) ?? 0) + 1;
    this.cleanupFailureCounts.set(entry, count);
    return count;
  }

  runRequesterSettleWake = (
    entry: SubagentRunRecord,
    run: () => Promise<unknown>,
    isCurrent: () => boolean,
  ): Promise<unknown> => {
    const runCurrent = async () => (isCurrent() ? run() : undefined);
    // Retry timers can outlive their original async scope. Reserve a detached
    // Gateway root before the limiter, then revalidate row ownership when the
    // execution slot opens; the queued wait still counts during restart drain.
    return runWithGatewayDetachedWorkContinuation(() => {
      if (!this.restoredRequesterSettleWakeRuns.has(entry.runId)) {
        return runCurrent();
      }
      const resolve = getGatewayContextResolver(entry);
      // Native caller wrappers share the instance resolver. Standalone bindings
      // retain their captured resolver; wholly unbound calls belong to this controller.
      const owner = (resolve && getCanonicalGatewayContextResolver(resolve)) ?? resolve ?? this;
      // Retired callbacks keep their queue and roots, but cannot consume the
      // replacement Gateway's capacity while their old async work unwinds.
      let limit = this.restoredRequesterSettleWakeLimits.get(owner);
      if (!limit) {
        limit = pLimit(RESTORED_REQUESTER_SETTLE_WAKE_CONCURRENCY);
        this.restoredRequesterSettleWakeLimits.set(owner, limit);
      }
      return limit(runCurrent);
    }, "subagents:lifecycle-wake");
  };
  unmarkRequesterSettleWakeRunScheduled = (entry: SubagentRunRecord): void => {
    this.scheduledRequesterSettleWakeRuns.delete(entry);
    // Retryable durable wakes remain startup recovery. Once settlement retires
    // that state, the same run id must return to the ordinary live path.
    if (
      !this.options.runs.get(entry.runId)?.requesterSettleWake &&
      !this.pendingRequesterSettleWakeCommits.get(entry)?.isCurrent(entry)
    ) {
      this.restoredRequesterSettleWakeRuns.delete(entry.runId);
    }
  };

  completeSubagentRun = async (completeParams: SubagentCompletionRequest) => {
    // Task finalization can make the run disappear from suspension blockers
    // before browser/MCP retirement and cleanup delivery hand off. Own this
    // entire transition as an independent root so that boundary stays atomic.
    // Callers can detach while retaining parent ALS, so nesting is intentional.
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      await completeSubagentRunAttempt(this, completeParams);
    }, "subagents:lifecycle-complete");
  };

  completeCleanupBookkeeping = (params: CleanupBookkeepingParams) => {
    return completeCleanupBookkeeping(this, params);
  };

  resumeAncestorCleanup = (settledEntry: SubagentRunRecord): void =>
    resumeAncestorCleanup(this, settledEntry);

  static discardTerminalDelivery(
    this: void,
    entry: SubagentRunRecord,
    completedAt: number,
    reason: "dismissed" | "expired" = "dismissed",
  ): void {
    const delivery = ensureDeliveryState(entry);
    const payload = delivery.payload;
    if (reason === "dismissed") {
      delivery.disposition = "intentional_non_delivery";
      delivery.dismissedAt = completedAt;
    } else {
      delivery.discardedAt = completedAt;
      delivery.discardReason = "expired";
      delivery.discardedPayloadSummary = {
        requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
        childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
        childRunId: payload?.childRunId ?? entry.runId,
        endedAt: payload?.endedAt ?? entry.execution.endedAt,
        status: payload?.outcome?.status ?? entry.execution.outcome?.status,
        lastError: getDeliveryLastError(entry) ?? null,
      };
    }
    Object.assign(delivery, { status: "discarded", queueId: undefined, nextAttemptAt: undefined });
    delivery.payload = undefined;
    Object.assign(delivery, { createdAt: undefined, lastAttemptAt: undefined });
    Object.assign(delivery, {
      attemptCount: undefined,
      lastError: undefined,
      announcedAt: undefined,
    });
    Object.assign(delivery, { suspendedAt: undefined, suspendedReason: undefined });
    Object.assign(entry, { wakeOnDescendantSettle: undefined, cleanupHandled: true });
    const completion = ensureCompletionState(entry);
    Object.assign(completion, { fallbackResultText: undefined, fallbackCapturedAt: undefined });
    entry.cleanupCompletedAt = completedAt;
  }

  finalizeResumedAnnounceGiveUp = (params: Parameters<typeof finalizeResumedAnnounceGiveUp>[1]) =>
    finalizeResumedAnnounceGiveUp(this, params);

  refreshFrozenResultFromSession = (sessionKey: string) =>
    refreshFrozenResultFromSession(this, sessionKey);

  resumeRequesterSettleWake = (
    runId: string,
    entry: SubagentRunRecord,
    source: "live" | "restore" = "live",
  ) => {
    if (source === "restore" && !this.scheduledRequesterSettleWakeRuns.has(entry)) {
      this.restoredRequesterSettleWakeRuns.add(runId);
    }
    scheduleRequesterSettleWake(this, runId, entry);
  };

  cancelRequesterSettleWake = (entry: SubagentRunRecord, assertCurrent: () => void) =>
    cancelRequesterSettleWake(this, entry, assertCurrent);

  adoptSubagentRunForRequesterTurn = (
    params: Omit<Parameters<typeof adoptSubagentRunForRequesterTurnInRuns>[0], "runs" | "persist">,
  ) => {
    if (this.newerGenerationOwnsSession(params.expected)) {
      return Promise.resolve(undefined);
    }
    return adoptSubagentRunForRequesterTurnInRuns({
      ...params,
      runs: this.options.runs,
      persist: this.options.persistAsyncOrThrow,
      assertPublicationCurrent: () =>
        subagentRuns.runWithCompletionAuthority(params.expected, () => {
          params.assertPublicationCurrent?.();
          if (this.newerGenerationOwnsSession(params.expected)) {
            throw new Error("Steered completion no longer owns its execution");
          }
        }),
      assertCurrent: () =>
        subagentRuns.runWithCompletionAuthority(params.expected, () => {
          params.assertCurrent();
          if (this.newerGenerationOwnsSession(params.expected)) {
            throw new Error("Steered completion no longer owns its execution");
          }
        }),
    });
  };

  private prepareRequesterInitialTransfer(
    assertCurrent?: () => void,
    stateContext = captureOpenClawStateWorkerContext(),
  ): RequesterInitialTransfer {
    // Logical settlement retains run or reply-operation authority beyond individual tool calls.
    return (params) =>
      commitRequesterInitialTransfer(this, {
        ...params,
        stateContext,
        assertCurrent: () => {
          assertSubagentRegistryWriteSourceCurrent(stateContext);
          assertCurrent?.();
        },
        scheduleRetry: (entry) =>
          scheduleRequesterSettleWake(this, entry.runId, entry, stateContext),
      });
  }

  markRequesterTurnYielded = async (args: {
    requesterSessionKey: string;
    requesterAgentId?: string;
    requesterTurnRunId: string;
    assertCurrent?: () => void;
    stateContext?: OpenClawStateWorkerContext;
    preparedAuthority?: PreparedRequesterCronAuthority | null;
  }) => {
    const ownsPreparation = args.preparedAuthority === undefined;
    const preparedAuthority =
      args.preparedAuthority === undefined
        ? prepareRequesterCronAuthority(args)
        : args.preparedAuthority;
    try {
      return await markRequesterTurnYieldedInRuns({
        ...args,
        preparedAuthority: preparedAuthority ?? null,
        runs: this.options.runs,
        transfer: this.prepareRequesterInitialTransfer(() => {
          args.assertCurrent?.();
          preparedAuthority?.assertCurrent();
        }, args.stateContext),
      });
    } finally {
      const release = ownsPreparation ? preparedAuthority?.release() : undefined;
      if (release) {
        await release;
      }
    }
  };

  settleRequesterTurnAfterSessionSpawns = (
    args: {
      requesterSessionKey: string;
      requesterAgentId?: string;
      requesterTurnRunId: string;
      requesterYielded: boolean;
      acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
      progressPresentation?: ProgressContinuationState;
      assertCurrent?: () => void;
      stateContext?: OpenClawStateWorkerContext;
    },
    source: "live" | "restore" = "live",
  ) =>
    settleRequesterTurnAfterSessionSpawns({
      ...args,
      runs: this.options.runs,
      transfer: this.prepareRequesterInitialTransfer(args.assertCurrent, args.stateContext),
      schedule: (runId, entry, kind) => {
        if (kind === "completion") {
          if (!this.cleanupFailureCounts.has(entry)) {
            this.options.resumedRuns.delete(runId);
            this.options.resumeSubagentRun(runId);
          }
          return;
        }
        if (this.scheduledRequesterSettleWakeRuns.has(entry)) {
          this.pendingRequesterSettleWakeRearms.add(entry);
          return;
        }
        if (source === "restore") {
          this.restoredRequesterSettleWakeRuns.add(runId);
        }
        scheduleRequesterSettleWake(this, runId, entry);
      },
    });

  startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean =>
    startSubagentAnnounceCleanupFlow(this, runId, entry);
}
