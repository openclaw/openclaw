import { isDeepStrictEqual } from "node:util";
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
import { deleteSuspendedSubagentSession as deleteSuspendedSubagentSessionCleanup } from "./subagent-registry-lifecycle-delete-cleanup.js";
import { refreshFrozenResultFromSession } from "./subagent-registry-lifecycle-delivery.js";
import { finalizeResumedAnnounceGiveUp } from "./subagent-registry-lifecycle-give-up.js";
import {
  cancelRequesterSettleWake,
  scheduleRequesterSettleWake,
} from "./subagent-registry-lifecycle-wake.js";
import { getCurrentSubagentRunOwner, subagentRuns } from "./subagent-registry-memory.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  mutateSubagentRuns,
  SubagentRegistryMutationRejectedError,
} from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
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
import {
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

export type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";

export class SubagentSessionCleanupRevocationChangedError extends SubagentRegistryMutationRejectedError {
  override name = "SubagentSessionCleanupRevocationChangedError";
}

// Restored rows can arrive in a large burst. Limit only that startup catch-up
// so ordinary live settles keep their existing latency and concurrency.
const RESTORED_REQUESTER_SETTLE_WAKE_CONCURRENCY = 2;

const COMPLETION_SETTLING_ERROR = "Subagent completion is still settling; retry the session reset.";

/** Terminal rows still carrying session effects must revoke them before a reset. */
const ownsSessionEffects = (entry: SubagentRunRecord): boolean =>
  entry.execution.status === "terminal" &&
  entry.pauseReason !== "sessions_yield" &&
  entry.execution.suppressSessionEffects !== true;

function terminalPublication(entry: SubagentRunRecord): readonly unknown[] {
  const execution = entry.execution;
  const outcome = execution.outcome;
  const completion = entry.completion;
  return [
    execution.status,
    execution.startedAt,
    execution.endedAt,
    outcome?.status,
    outcome?.status === "error" ? outcome.error : undefined,
    outcome?.startedAt,
    outcome?.endedAt,
    outcome?.elapsedMs,
    execution.interruptionReason,
    execution.suppressSessionEffects,
    entry.pauseReason,
    entry.endedReason,
    entry.killIntent,
    entry.killReconciliation?.killedAt,
    entry.killReconciliation?.supersededAt,
    entry.killReconciliation?.suppressTaskDelivery,
    completion?.resultText,
    completion?.capturedAt,
    completion?.terminalReply,
  ];
}

export class SubagentLifecycleController {
  readonly pendingRequesterSettleWakeCommits = new Map<object, PendingRequesterSettleWakeCommit>();
  readonly scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();
  pendingRequesterSettleWakeRearms = new Set<object>();
  readonly cancelledRequesterSettleWakeRuns = new Set<object>();
  readonly scheduledRequesterSettleWakeRuns = new Set<object>();
  private readonly restoredRequesterSettleWakeRuns = new Set<object>();
  private readonly restoredRequesterSettleWakeLimits = new WeakMap<
    object,
    ReturnType<typeof pLimit>
  >();
  readonly scheduledRequesterSettleWakeTimers = new Map<string, ScheduledRequesterSettleWake>();
  private readonly terminalCompletionLocks = new Map<object, Promise<void>>();
  private readonly terminalGenerations = new WeakMap<object, number>();
  private readonly terminalPublications = new WeakMap<object, readonly unknown[]>();
  private readonly terminalSessionEffects = new WeakMap<object, SubagentSessionEffects>();
  private readonly cleanupGenerations = new WeakMap<object, number>();
  readonly progressEndedEntries = new WeakSet<object>();
  readonly cleanupReservations = new Set<object>();
  readonly activeCleanupAttempts = new Map<object, number>();
  readonly cleanupFailureCounts = new WeakMap<object, number>();

  private readonly runtimeRuns = new Map<object, SubagentRunRecord>();
  private readonly terminalEffectUsers = new Map<object, number>();
  private stopRuntimePruning?: () => void;

  constructor(readonly options: SubagentLifecycleOptions) {}

  private trackRun(entry: SubagentRunRecord): object {
    this.stopRuntimePruning ??= subscribeSubagentRunChanges("projection", ({ runIds }) =>
      this.pruneRetiredRuns(runIds),
    );
    const identity = getSubagentRunRuntimeKey(entry);
    this.runtimeRuns.set(identity, entry);
    return identity;
  }

  pruneRetiredRuns = (changedRunIds?: readonly string[]): void => {
    const changed = changedRunIds && new Set(changedRunIds);
    for (const [identity, observed] of this.runtimeRuns) {
      const current = getCurrentSubagentRunOwner(this.options.runs, observed);
      if (
        changed &&
        !changed.has(observed.runId) &&
        !(observed.collect && observed.swarmRunId && changed.has(observed.swarmRunId)) &&
        !(current && changed.has(current.runId))
      ) {
        continue;
      }
      if (current) {
        this.runtimeRuns.set(identity, current);
      }
      const pending = this.pendingRequesterSettleWakeCommits.get(identity);
      if (
        current &&
        getSubagentRunRuntimeKey(current) === identity &&
        this.terminalPublications.has(identity)
      ) {
        this.bumpTerminalGeneration(current);
      }
      if (
        (current && getSubagentRunRuntimeKey(current) === identity) ||
        this.terminalEffectUsers.has(identity) ||
        this.cleanupReservations.has(identity) ||
        this.activeCleanupAttempts.has(identity) ||
        this.scheduledRequesterSettleWakeRuns.has(identity) ||
        pending?.inFlight ||
        pending?.ownsRetirement(observed) ||
        (pending?.initialTransfer && !pending.initialTransfer.completed)
      ) {
        continue;
      }
      this.runtimeRuns.delete(identity);
      this.options.resumedRuns.delete(identity);
      this.pendingRequesterSettleWakeCommits.delete(identity);
      this.pendingRequesterSettleWakeRearms.delete(identity);
      this.cancelledRequesterSettleWakeRuns.delete(identity);
      this.restoredRequesterSettleWakeRuns.delete(identity);
    }
  };

  newerGenerationOwnsSession(entry: SubagentRunRecord): boolean {
    const current = getCurrentSubagentRunOwner(this.options.runs, entry) ?? entry;
    if (current.killReconciliation?.supersededAt !== undefined) {
      return true;
    }
    const latest = this.options.getLatestRunForChildSession(
      current.childSessionKey,
      (candidate) => candidate.runId !== current.runId,
      current.childAgentId,
    );
    return latest !== null && compareSubagentRunGeneration(latest, current) > 0;
  }

  bindTerminalSessionEffects(entry: SubagentRunRecord, effects?: SubagentSessionEffects): void {
    if (effects) {
      this.terminalSessionEffects.set(this.trackRun(entry), effects);
    }
  }

  private liveRow(entry: SubagentRunRecord): SubagentRunRecord | undefined {
    return (
      this.options.runs.get(entry.runId) ?? getCurrentSubagentRunOwner(this.options.runs, entry)
    );
  }

  private sessionEffectsSuppressed(entry: SubagentRunRecord): boolean {
    const current = this.liveRow(entry);
    return (
      (current !== undefined && !isSameSubagentRunOwner(current, entry)) ||
      this.newerGenerationOwnsSession(entry) ||
      shouldSuppressSubagentRecoverySessionEffects(current ?? entry)
    );
  }

  async shouldSuppressSessionEffects(
    entry: SubagentRunRecord,
    prospectiveEffects?: SubagentSessionEffects,
  ): Promise<boolean> {
    const boundEffects = this.terminalSessionEffects.get(getSubagentRunRuntimeKey(entry));
    const effects = prospectiveEffects ?? boundEffects;
    return (
      this.sessionEffectsSuppressed(entry) ||
      (await effects?.isCurrent()) === false ||
      this.terminalSessionEffects.get(getSubagentRunRuntimeKey(entry)) !== boundEffects ||
      this.sessionEffectsSuppressed(entry)
    );
  }

  sessionEffectsHostCurrent(entry: SubagentRunRecord): boolean {
    if (this.sessionEffectsSuppressed(entry)) {
      return false;
    }
    try {
      this.terminalSessionEffects.get(getSubagentRunRuntimeKey(entry))?.assertHostCurrent();
      return true;
    } catch {
      return false;
    }
  }

  getSessionEffects(entry: SubagentRunRecord): SubagentSessionEffects | undefined {
    return this.terminalSessionEffects.get(getSubagentRunRuntimeKey(entry));
  }

  async acquireTerminalCompletionLock(runId: string): Promise<() => void> {
    const entry = this.options.runs.get(runId);
    if (!entry) {
      return () => {};
    }
    const owner = getSubagentRunRuntimeKey(entry);
    const previous = this.terminalCompletionLocks.get(owner) ?? Promise.resolve();
    const { promise: current, resolve: releaseLock } = createDeferredCore();
    this.terminalCompletionLocks.set(owner, current);
    await previous;
    return () => {
      releaseLock();
      if (this.terminalCompletionLocks.get(owner) === current) {
        this.terminalCompletionLocks.delete(owner);
      }
    };
  }

  /** Persist revocation before reset prepares its synchronous successor guard. */
  async revokeTerminalSessionEffects(
    entries: Iterable<SubagentRunRecord>,
    assertCurrent?: () => void,
  ): Promise<void> {
    const selected = new Map([...entries].map((entry) => [entry.runId, entry]));
    await mutateSubagentRuns(
      [...selected.keys()],
      (rows) => {
        const postimages = new Map<string, SubagentRunRecord>();
        for (const [runId, expected] of selected) {
          const entry = rows.get(runId);
          if (!entry) {
            continue;
          }
          if (!isSameSubagentRunOwner(entry, expected)) {
            throw new SubagentRegistryMutationRejectedError(
              "Subagent cleanup owner changed before reset",
            );
          }
          this.assertCompletionSettled(entry);
          if (ownsSessionEffects(entry)) {
            postimages.set(runId, {
              ...entry,
              execution: { ...entry.execution, suppressSessionEffects: true },
            });
          }
        }
        return { value: undefined, postimages };
      },
      { runs: this.options.runs, assertCurrent },
    );
  }

  private assertCompletionSettled(entry: SubagentRunRecord): void {
    if (this.terminalCompletionLocks.has(getSubagentRunRuntimeKey(entry))) {
      throw new Error(COMPLETION_SETTLING_ERROR);
    }
  }

  assertTerminalSessionEffectsRevoked(currentEntries: Iterable<SubagentRunRecord>): void {
    for (const entry of currentEntries) {
      this.assertCompletionSettled(entry);
      if (ownsSessionEffects(entry)) {
        throw new SubagentSessionCleanupRevocationChangedError(
          "Subagent cleanup revocation changed before reset",
        );
      }
    }
  }

  clearScheduledResumeTimers = () => {
    for (const timer of this.scheduledResumeTimers) {
      clearTimeout(timer);
    }
    this.scheduledResumeTimers.clear();
    for (const scheduled of this.scheduledRequesterSettleWakeTimers.values()) {
      clearTimeout(scheduled.timer);
      this.pendingRequesterSettleWakeCommits
        .get(getSubagentRunRuntimeKey(scheduled.entry))
        ?.initialTransfer?.retire();
    }
    for (const entry of this.options.runs.values()) {
      this.pendingRequesterSettleWakeCommits
        .get(getSubagentRunRuntimeKey(entry))
        ?.initialTransfer?.retire();
    }
    this.scheduledRequesterSettleWakeTimers.clear();
    this.pendingRequesterSettleWakeRearms = new Set();
    this.cancelledRequesterSettleWakeRuns.clear();
    this.pendingRequesterSettleWakeCommits.clear();
    this.scheduledRequesterSettleWakeRuns.clear();
    this.cleanupReservations.clear();
    this.runtimeRuns.clear();
    this.stopRuntimePruning?.();
    this.stopRuntimePruning = undefined;
  };

  bumpCleanupGeneration(entry: SubagentRunRecord): number {
    const identity = this.trackRun(entry);
    const generation = (this.cleanupGenerations.get(identity) ?? 0) + 1;
    this.cleanupGenerations.set(identity, generation);
    return generation;
  }

  isCleanupGeneration = (entry: SubagentRunRecord, generation: number): boolean =>
    this.cleanupGenerations.get(getSubagentRunRuntimeKey(entry)) === generation;
  isCleanupGenerationCurrent = (entry: SubagentRunRecord, generation: number): boolean => {
    const current = getCurrentSubagentRunOwner(this.options.runs, entry);
    return (
      current !== undefined &&
      current.pauseReason !== "sessions_yield" &&
      this.isCleanupGeneration(entry, generation)
    );
  };
  isCleanupAttemptCurrent = (entry: SubagentRunRecord, generation: number): boolean =>
    getCurrentSubagentRunOwner(this.options.runs, entry)?.cleanupHandled === true &&
    this.isCleanupGenerationCurrent(entry, generation);
  isCleanupOwnerCurrent = (entry: SubagentRunRecord): boolean => {
    const current = this.liveRow(entry);
    return (
      (current === undefined || isSameSubagentRunOwner(current, entry)) &&
      (current ?? entry).pauseReason !== "sessions_yield"
    );
  };
  isEndedHookOwnerCurrent = (entry: SubagentRunRecord): boolean =>
    this.isCleanupOwnerCurrent(entry) && !this.newerGenerationOwnsSession(entry);

  bumpTerminalGeneration(entry: SubagentRunRecord, bindingChanged = false): number {
    const identity = this.trackRun(entry);
    const previous = this.terminalGenerations.get(identity) ?? 0;
    const publication = terminalPublication(entry);
    const changed = !isDeepStrictEqual(this.terminalPublications.get(identity), publication);
    const generation = changed || bindingChanged || previous === 0 ? previous + 1 : previous;
    this.terminalGenerations.set(identity, generation);
    this.terminalPublications.set(identity, publication);
    return generation;
  }

  isTerminalCallbackCurrent = (entry: SubagentRunRecord, generation: number): boolean => {
    const current = getCurrentSubagentRunOwner(this.options.runs, entry);
    return (
      current !== undefined &&
      current.pauseReason !== "sessions_yield" &&
      this.terminalGenerations.get(getSubagentRunRuntimeKey(entry)) === generation &&
      isDeepStrictEqual(
        this.terminalPublications.get(getSubagentRunRuntimeKey(entry)),
        terminalPublication(current),
      )
    );
  };
  incrementCleanupFailureCount(entry: SubagentRunRecord): number {
    const identity = this.trackRun(entry);
    const count = (this.cleanupFailureCounts.get(identity) ?? 0) + 1;
    this.cleanupFailureCounts.set(identity, count);
    return count;
  }

  runRequesterSettleWake = (
    entry: SubagentRunRecord,
    run: () => Promise<unknown>,
    isCurrent: () => boolean,
  ): Promise<unknown> => {
    this.trackRun(entry);
    const runCurrent = async () => (isCurrent() ? run() : undefined);
    // Retry timers can outlive their original async scope. Reserve a detached
    // Gateway root before the limiter, then revalidate row ownership when the
    // execution slot opens; the queued wait still counts during restart drain.
    return runWithGatewayDetachedWorkContinuation(() => {
      if (!this.restoredRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry))) {
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
    this.scheduledRequesterSettleWakeRuns.delete(getSubagentRunRuntimeKey(entry));
    this.pruneRetiredRuns([entry.runId]);
    // Retryable durable wakes remain startup recovery. Once settlement retires
    // that state, the same run id must return to the ordinary live path.
    if (
      !getCurrentSubagentRunOwner(this.options.runs, entry)?.requesterSettleWake &&
      !this.pendingRequesterSettleWakeCommits.get(getSubagentRunRuntimeKey(entry))?.isCurrent(entry)
    ) {
      this.restoredRequesterSettleWakeRuns.delete(getSubagentRunRuntimeKey(entry));
    }
  };

  completeSubagentRun = async (completeParams: SubagentCompletionRequest) => {
    // Task finalization can make the run disappear from suspension blockers
    // before browser/MCP retirement and cleanup delivery hand off. Own this
    // entire transition as an independent root so that boundary stays atomic.
    // Callers can detach while retaining parent ALS, so nesting is intentional.
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      const entry = completeParams.expectedEntry
        ? getCurrentSubagentRunOwner(this.options.runs, completeParams.expectedEntry)
        : this.options.runs.get(completeParams.runId);
      const identity = entry && this.trackRun(entry);
      if (identity) {
        this.terminalEffectUsers.set(identity, (this.terminalEffectUsers.get(identity) ?? 0) + 1);
      }
      try {
        await completeSubagentRunAttempt(this, completeParams);
      } finally {
        if (identity) {
          const count = (this.terminalEffectUsers.get(identity) ?? 1) - 1;
          if (count) {
            this.terminalEffectUsers.set(identity, count);
          } else {
            this.terminalEffectUsers.delete(identity);
          }
        }
        this.pruneRetiredRuns([completeParams.runId]);
      }
    }, "subagents:lifecycle-complete");
  };

  deleteSuspendedSubagentSession = (
    params: Parameters<typeof deleteSuspendedSubagentSessionCleanup>[1],
  ) => deleteSuspendedSubagentSessionCleanup(this, params);

  completeCleanupBookkeeping = (params: CleanupBookkeepingParams) =>
    completeCleanupBookkeeping(this, params);

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
    Object.assign(delivery, {
      status: "discarded",
      queueId: undefined,
      nextAttemptAt: undefined,
      payload: undefined,
      createdAt: undefined,
      lastAttemptAt: undefined,
      attemptCount: undefined,
      lastError: undefined,
      announcedAt: undefined,
      suspendedAt: undefined,
      suspendedReason: undefined,
    });
    Object.assign(entry, { wakeOnDescendantSettle: undefined, cleanupHandled: true });
    const completion = ensureCompletionState(entry);
    Object.assign(completion, { fallbackResultText: undefined, fallbackCapturedAt: undefined });
    entry.cleanupCompletedAt = completedAt;
  }

  finalizeResumedAnnounceGiveUp = (params: Parameters<typeof finalizeResumedAnnounceGiveUp>[1]) =>
    finalizeResumedAnnounceGiveUp(this, params);

  refreshFrozenResultFromSession = (sessionKey: string) =>
    refreshFrozenResultFromSession(this, sessionKey);

  markRequesterSettleWakeRestored = (entry: SubagentRunRecord): void => {
    const current = getCurrentSubagentRunOwner(this.options.runs, entry);
    if (current) {
      this.restoredRequesterSettleWakeRuns.add(this.trackRun(current));
    }
  };

  resumeRequesterSettleWake = (
    runId: string,
    entry: SubagentRunRecord,
    source: "live" | "restore" = "live",
  ) => {
    this.trackRun(entry);
    if (
      source === "restore" &&
      !this.scheduledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry))
    ) {
      this.markRequesterSettleWakeRestored(entry);
    }
    scheduleRequesterSettleWake(this, runId, entry);
  };

  cancelRequesterSettleWake = (entry: SubagentRunRecord, assertCurrent: () => void) =>
    cancelRequesterSettleWake(this, entry, assertCurrent);

  adoptSubagentRunForRequesterTurn = (
    params: Omit<Parameters<typeof adoptSubagentRunForRequesterTurnInRuns>[0], "runs">,
  ) => {
    if (this.newerGenerationOwnsSession(params.expected)) {
      return Promise.resolve(undefined);
    }
    return adoptSubagentRunForRequesterTurnInRuns({
      ...params,
      runs: this.options.runs,
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
        this.trackRun(entry);
        if (kind === "completion") {
          if (!this.cleanupFailureCounts.has(getSubagentRunRuntimeKey(entry))) {
            this.options.resumedRuns.delete(getSubagentRunRuntimeKey(entry));
            this.options.resumeSubagentRun(runId);
          }
          return;
        }
        if (this.scheduledRequesterSettleWakeRuns.has(getSubagentRunRuntimeKey(entry))) {
          this.pendingRequesterSettleWakeRearms.add(getSubagentRunRuntimeKey(entry));
          return;
        }
        if (source === "restore") {
          this.markRequesterSettleWakeRestored(entry);
        }
        scheduleRequesterSettleWake(this, runId, entry);
      },
    });

  startSubagentAnnounceCleanupFlow = (entry: SubagentRunRecord): boolean =>
    startSubagentAnnounceCleanupFlow(this, entry);
}
