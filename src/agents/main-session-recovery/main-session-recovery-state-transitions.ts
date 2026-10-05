import { isDeepStrictEqual } from "node:util";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import {
  accountSessionGoalUsage,
  buildUpdatedSessionGoalStatus,
} from "../../config/sessions/goals-transitions.js";
import type { TurnRecoveryIntent } from "../../config/sessions/main-session-recovery.types.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
  buildRestartRecoveryClaimCleanupPatch,
} from "../../config/sessions/restart-recovery-state.js";
import { hasOpaqueProviderCapacityWait } from "./main-session-recovery-empty-aggregate.js";
import type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryConflict,
  MainSessionRecoveryObservation,
  MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-types.js";

export function isMainSessionRecoveryPending(entry: SessionEntry, sessionKey: string): boolean {
  const state = entry.mainRestartRecovery;
  return (
    hasMainSessionRecoveryClaim(entry) &&
    entry.abortedLastRun === true &&
    isMainSessionRecoveryIntentCurrent(entry) &&
    isMainRestartRecoveryCandidate(entry, sessionKey) &&
    !state?.foregroundClaims &&
    !state?.reservation &&
    !state?.pause &&
    !state?.tombstone
  );
}

export function updateRecoveryState(
  entry: SessionEntry,
  state: MainRestartRecoveryState,
  patch: Omit<Partial<MainRestartRecoveryState>, "revision">,
): MainRestartRecoveryState {
  return (entry.mainRestartRecovery = { ...state, revision: state.revision + 1, ...patch });
}

export function isForegroundRecoveryInputCurrent(
  entry: SessionEntry,
  intent: TurnRecoveryIntent | undefined,
): boolean {
  return (
    !intent ||
    (entry.goal?.status !== "active" &&
      !entry.restartRecoveryGoal &&
      isDeepStrictEqual(entry.mainRestartRecovery?.turnIntent, intent))
  );
}

/** Goal intent is bound to its original session lifecycle, not a later goal or manual pause. */
export function isCapturedMainRestartGoalCurrent(entry: SessionEntry): boolean {
  const captured = entry.restartRecoveryGoal;
  return (
    captured !== undefined &&
    captured.sessionId === entry.sessionId &&
    captured.lifecycleRevision === entry.lifecycleRevision &&
    captured.id === entry.goal?.id &&
    (entry.goal.status === "active" ||
      (entry.goal.status === "paused" && entry.goalPauseOrigin === "terminal-error")) &&
    entry.archivedAt === undefined
  );
}

/** A goal added or paused during drain also fences a previously goal-less accepted turn. */
export function isMainSessionRecoveryIntentCurrent(entry: SessionEntry): boolean {
  return (
    entry.archivedAt === undefined &&
    !hasOpaqueProviderCapacityWait(entry) &&
    (!entry.goal ||
      entry.goal.status === "active" ||
      (entry.goal.status === "paused" && entry.goalPauseOrigin === "terminal-error")) &&
    (!entry.restartRecoveryGoal || isCapturedMainRestartGoalCurrent(entry))
  );
}

export function matchesObservation(
  entry: SessionEntry,
  observation: MainSessionRecoveryObservation,
): MainSessionRecoveryConflict | null {
  if (entry.sessionId !== observation.sessionId) {
    return "session_replaced";
  }
  if (entry.mainRestartRecovery?.cycleId !== observation.cycleId) {
    return "stale_cycle";
  }
  return entry.mainRestartRecovery.revision === observation.revision ? null : "stale_revision";
}

export function refundMainSessionRecoveryWorkerWait(entry: SessionEntry): void {
  const state = entry.mainRestartRecovery;
  const wait = state?.capacityWait;
  const attempt = wait?.provider?.attempt ?? wait?.worker?.attempt;
  if (
    state &&
    wait &&
    !hasOpaqueProviderCapacityWait(entry) &&
    ((wait.worker?.launchId && wait.worker.planHash && !wait.provider) ||
      (wait.provider?.kind === "settled-shortage-v1" &&
        wait.provider.refunded !== true &&
        !wait.worker &&
        wait.provider.operationId &&
        wait.provider.leaseId &&
        wait.provider.attemptName &&
        wait.provider.attemptNonce)) &&
    state.chargedAttempts === attempt &&
    state.startedAttempt !== attempt &&
    entry.lifecycleRunId === wait.runId
  ) {
    // This exact admitted attempt never crossed execution. A restored wait
    // cannot spend the failure budget merely because its Gateway retired.
    updateRecoveryState(entry, state, {
      chargedAttempts: Math.max(0, state.chargedAttempts - 1),
      ...(wait.provider
        ? { capacityWait: { ...wait, provider: { ...wait.provider, refunded: true } } }
        : {}),
    });
  }
}

/** Automatic recovery keeps the existing window; only an explicit resume resets it. */
export function activateCapturedMainRestartGoal(
  entry: SessionEntry,
  state: MainRestartRecoveryState,
  now: number,
): boolean {
  if (!entry.restartRecoveryGoal || !entry.goal) {
    return true;
  }
  const previousLimitedAt = entry.goal.budgetLimitedAt;
  entry.goal = accountSessionGoalUsage(
    { ...entry, goal: { ...entry.goal, status: "active", updatedAt: now } },
    now,
  );
  entry.goalPauseOrigin = undefined;
  if (entry.goal?.status === "budget_limited") {
    entry.goal.budgetLimitedAt = previousLimitedAt ?? entry.goal.budgetLimitedAt;
    updateRecoveryState(entry, state, {
      chargedAttempts: Math.max(0, state.chargedAttempts - 1),
      reservation: undefined,
    });
    return false;
  }
  return true;
}

export function transitionMainSessionRecoveryCapacityWait(
  entry: SessionEntry,
  command: Extract<
    MainSessionRecoveryCommand,
    {
      kind:
        | "wait_capacity"
        | "wait_worker_capacity"
        | "wait_provider_capacity"
        | "finish_provider_capacity"
        | "validate_provider_recovery"
        | "finish_worker_capacity"
        | "validate_worker_recovery"
        | "cancel_capacity_wait";
    }
  >,
): MainSessionRecoveryTransitionResult {
  const state = entry.mainRestartRecovery;
  if (command.kind === "cancel_capacity_wait") {
    const wait = command.wait;
    if (entry.sessionId !== wait.sessionId || state?.cycleId !== wait.cycleId) {
      return { kind: "rejected", reason: "stale_cycle" };
    }
    if (!state.capacityWait) {
      return { kind: "no_change" };
    }
    if (
      state.capacityWait.runId !== wait.runId ||
      state.capacityWait.lifecycleGeneration !== wait.lifecycleGeneration ||
      JSON.stringify(state.capacityWait.worker) !== JSON.stringify(wait.worker) ||
      JSON.stringify(state.capacityWait.provider) !== JSON.stringify(wait.provider)
    ) {
      return { kind: "rejected", reason: "stale_reservation" };
    }
    updateRecoveryState(entry, state, { capacityWait: undefined });
    return { kind: "applied" };
  }
  if (
    command.kind === "wait_worker_capacity" ||
    command.kind === "finish_worker_capacity" ||
    command.kind === "validate_worker_recovery" ||
    command.kind === "wait_provider_capacity" ||
    command.kind === "finish_provider_capacity" ||
    command.kind === "validate_provider_recovery"
  ) {
    const capacity = "worker" in command ? command.worker : command.provider;
    const validate =
      command.kind === "validate_worker_recovery" || command.kind === "validate_provider_recovery";
    if (
      entry.sessionId !== command.sessionId ||
      state?.cycleId !== command.cycleId ||
      state.chargedAttempts !== capacity.attempt ||
      (!validate && state.startedAttempt === capacity.attempt) ||
      entry.lifecycleRunId !== command.runId ||
      entry.lifecycleRevision !== command.lifecycleRevision ||
      entry.archivedAt !== undefined ||
      (entry.goal?.status === "paused" && entry.goalPauseOrigin !== "terminal-error") ||
      entry.abortedLastRun === true ||
      state.reservation ||
      state.foregroundClaims ||
      state.tombstone ||
      !entry.restartRecoveryRuns?.some(
        (run) =>
          run.runId === command.runId && run.lifecycleGeneration === command.lifecycleGeneration,
      )
    ) {
      return { kind: "rejected", reason: "stale_reservation" };
    }
    if (validate) {
      return { kind: "no_change" };
    }
    const exactWait =
      state.capacityWait?.runId === command.runId &&
      state.capacityWait.lifecycleGeneration === command.lifecycleGeneration &&
      ("worker" in command
        ? JSON.stringify(state.capacityWait.worker) === JSON.stringify(command.worker) &&
          state.capacityWait.provider === undefined
        : JSON.stringify(state.capacityWait.provider) === JSON.stringify(command.provider) &&
          state.capacityWait.worker === undefined);
    if (command.kind === "finish_worker_capacity" || command.kind === "finish_provider_capacity") {
      if (!exactWait) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      updateRecoveryState(entry, state, { capacityWait: undefined });
      return { kind: "applied" };
    }
    if (exactWait) {
      return { kind: "no_change" };
    }
    updateRecoveryState(entry, state, {
      capacityWait: {
        runId: command.runId,
        lifecycleGeneration: command.lifecycleGeneration,
        sinceMs: command.now,
        ...("worker" in command ? { worker: command.worker } : { provider: command.provider }),
      },
    });
    return { kind: "applied" };
  }
  const conflict = matchesObservation(entry, command.observation);
  if (conflict) {
    return { kind: "rejected", reason: conflict };
  }
  if (
    !state ||
    entry.abortedLastRun !== true ||
    state.reservation ||
    state.foregroundClaims ||
    state.tombstone
  ) {
    return { kind: "rejected", reason: "not_interrupted" };
  }
  updateRecoveryState(entry, state, {
    capacityWait: {
      runId: command.runId,
      lifecycleGeneration: command.lifecycleGeneration,
      sinceMs: command.now,
    },
  });
  return { kind: "applied" };
}

export function transitionMainSessionRecoveryPause(
  entry: SessionEntry,
  command: Extract<MainSessionRecoveryCommand, { kind: "pause" | "acknowledge_pause" }>,
): MainSessionRecoveryTransitionResult {
  if (command.kind === "acknowledge_pause" && command.noReplay) {
    const state = entry.mainRestartRecovery;
    const decision = command.noReplay;
    const turn = state?.turnIntent;
    if (
      !state ||
      !turn ||
      entry.goal ||
      entry.restartRecoveryGoal ||
      entry.goalPauseOrigin === "manual" ||
      state.tombstone ||
      entry.archivedAt !== undefined ||
      entry.lifecycleRevision !== decision.lifecycleRevision ||
      turn.sessionId !== entry.sessionId ||
      turn.lifecycleRevision !== entry.lifecycleRevision ||
      turn.repositoryWorkspaceId !== entry.repositoryWorkspaceId ||
      turn.runId !== decision.runId ||
      turn.issuer.profileId !== decision.profileId ||
      !isDeepStrictEqual(turn.issuer.factoryActor, decision.factoryActor) ||
      entry.sessionId !== decision.sessionId ||
      state.cycleId !== decision.cycleId ||
      command.observation.sessionId !== decision.sessionId ||
      command.observation.cycleId !== decision.cycleId ||
      command.observation.revision !== decision.revision
    ) {
      return { kind: "rejected", reason: "stale_revision" };
    }
    if (state.noReplayAcknowledgment) {
      return isDeepStrictEqual(state.noReplayAcknowledgment.decision, decision) &&
        state.revision === decision.revision + 1 &&
        entry.abortedLastRun === false &&
        !entry.lifecycleRunId &&
        !entry.activeWriterRunId &&
        !state.reservation &&
        !state.foregroundClaims &&
        !state.capacityWait &&
        !state.queuedInputsPending
        ? { kind: "no_change" }
        : { kind: "rejected", reason: "stale_revision" };
    }
    const pause = state.pause;
    if (
      state.revision !== decision.revision ||
      !pause ||
      pause.pausedAtMs !== decision.pausedAtMs ||
      pause.toolCallId !== decision.toolCallId ||
      entry.status !== "interrupted" ||
      entry.abortedLastRun !== true ||
      state.reservation ||
      state.foregroundClaims ||
      state.capacityWait ||
      state.queuedInputsPending ||
      state.queuedInputId ||
      entry.activeWriterRunId ||
      entry.lifecycleRunId ||
      entry.pendingFinalDelivery ||
      entry.restartRecoveryDeliverySourceRunId !== turn.runId ||
      entry.restartRecoveryRuns?.some((run) => run.runId !== turn.runId)
    ) {
      return { kind: "rejected", reason: "foreground_active" };
    }
    // Retire custody, not the effect: no tool result or successful outcome is manufactured.
    Object.assign(
      entry,
      buildRestartRecoveryClaimCleanupPatch({
        entry,
        recordTerminalSource: true,
        terminalRunId: turn.runId,
        terminalSourceRunId: turn.runId,
      }),
    );
    entry.restartRecoveryRuns ??= [
      { runId: turn.runId, lifecycleGeneration: turn.lifecycleGeneration },
    ];
    updateRecoveryState(entry, state, {
      pause: undefined,
      acknowledgedPause: undefined,
      noReplayAcknowledgment: { decision, acknowledgedAtMs: command.now },
    });
    entry.abortedLastRun = false;
    entry.status = "killed";
    entry.lastRunId = turn.runId;
    entry.lastRunError = undefined;
    entry.updatedAt = command.now;
    return { kind: "applied" };
  }
  const conflict = matchesObservation(entry, command.observation);
  if (conflict) {
    return { kind: "rejected", reason: conflict };
  }
  const state = entry.mainRestartRecovery!;
  if (command.kind === "acknowledge_pause") {
    if (!state.pause || state.reservation || state.foregroundClaims) {
      return { kind: "rejected", reason: "foreground_active" };
    }
    if (
      state.pause.goalId &&
      entry.goal?.id === state.pause.goalId &&
      entry.goal.status === "paused" &&
      entry.goalPauseOrigin === "recovery-hold" &&
      entry.goal.updatedAt === state.pause.pausedAtMs
    ) {
      entry.goal = buildUpdatedSessionGoalStatus(entry, { status: "active" }, command.now);
      entry.goalPauseOrigin = undefined;
    }
    updateRecoveryState(entry, state, { acknowledgedPause: state.pause, pause: undefined });
    entry.lastRunError = undefined;
    entry.updatedAt = command.now;
    return { kind: "applied" };
  }
  if (entry.abortedLastRun !== true) {
    return { kind: "rejected", reason: "not_interrupted" };
  }
  if (state.reservation || state.foregroundClaims) {
    return {
      kind: "rejected",
      reason: state.reservation ? "reservation_active" : "foreground_active",
    };
  }
  const goalId = entry.goal?.status === "active" ? entry.goal.id : undefined;
  if (goalId) {
    entry.goal = buildUpdatedSessionGoalStatus(
      entry,
      {
        status: "paused",
        note: "An interrupted external action has no verified outcome. Review it before continuing.",
      },
      command.now,
    );
  }
  updateRecoveryState(entry, state, {
    pause: { ...command.effect, pausedAtMs: command.now, ...(goalId ? { goalId } : {}) },
  });
  if (goalId) {
    entry.goalPauseOrigin = "recovery-hold";
  }
  entry.lastRunError =
    "Paused: an interrupted external action has no verified outcome. Review it and choose whether to continue before starting any work.";
  entry.updatedAt = command.now;
  return { kind: "applied" };
}

export function hasCurrentForegroundClaim(
  state: MainRestartRecoveryState,
  lifecycleGeneration: string,
): boolean {
  return (
    state.foregroundClaims?.lifecycleGeneration === lifecycleGeneration &&
    state.foregroundClaims.tokens.length > 0
  );
}

export function ownsForegroundClaim(
  state: MainRestartRecoveryState | undefined,
  claim: { cycleId: string; lifecycleGeneration: string; claimId: string },
): boolean {
  return (
    state?.cycleId === claim.cycleId &&
    state.foregroundClaims?.lifecycleGeneration === claim.lifecycleGeneration &&
    state.foregroundClaims.tokens.includes(claim.claimId)
  );
}

export function validateRecoveryAdmission(
  entry: SessionEntry,
  command: Extract<MainSessionRecoveryCommand, { kind: "validate_recovery" | "admit_recovery" }>,
): MainSessionRecoveryConflict | null {
  const state = entry.mainRestartRecovery;
  if (entry.sessionId !== command.sessionId) {
    return "session_replaced";
  }
  if (
    command.deliveryClaim &&
    (entry.restartRecoveryDeliveryRunId !== command.deliveryClaim.runId ||
      entry.restartRecoveryDeliverySourceRunId !== command.deliveryClaim.sourceRunId)
  ) {
    return "stale_reservation";
  }
  if (entry.abortedLastRun !== true || !state || !isMainSessionRecoveryIntentCurrent(entry)) {
    return "not_interrupted";
  }
  if (
    state.reservation?.runId !== command.runId ||
    state.reservation.lifecycleGeneration !== command.lifecycleGeneration
  ) {
    return "stale_reservation";
  }
  return hasCurrentForegroundClaim(state, command.lifecycleGeneration) ? "foreground_active" : null;
}
