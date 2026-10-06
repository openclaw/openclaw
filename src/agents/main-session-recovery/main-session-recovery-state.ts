import {
  PENDING_FINAL_DELIVERY_CLEAR_PATCH,
  sanitizePendingFinalDeliveryText,
} from "../../auto-reply/reply/pending-final-delivery-state.js";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
  hasRestartRecoveryTerminalRun,
  isRetryableUnadoptedChatClaim,
  recordLifecycleFence,
} from "../../config/sessions/restart-recovery-state.js";
import { isTerminalSessionStatus } from "../../config/sessions/types.js";
import {
  buildMainSessionRecoveryClearPatch,
  buildMainSessionRecoverySettlementPatch,
  removeMainSessionRecoveryForegroundClaim,
} from "./main-session-recovery-clear.js";
import type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryConflict,
  MainSessionRecoveryObservation,
  MainSessionRecoveryTransitionResult,
  MainSessionRecoveryView,
} from "./main-session-recovery-types.js";
import {
  MAX_RECOVERY_RETRIES,
  resolveRestartRecoveryTerminalClientRunId,
} from "./main-session-restart-recovery-shared.js";

export type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryObservation,
  MainSessionRecoveryOwnerClaim,
  MainSessionRecoveryReservation,
  MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-types.js";

const MAIN_RESTART_RECOVERY_REMEDIATION_HINT =
  "inspect the failed main session and use /new or reset to start a replacement session";

function updateRecoveryState(
  entry: SessionEntry,
  state: MainRestartRecoveryState,
  patch: Omit<Partial<MainRestartRecoveryState>, "revision">,
): MainRestartRecoveryState {
  return (entry.mainRestartRecovery = { ...state, revision: state.revision + 1, ...patch });
}

function createCycle(cycleId: string): MainRestartRecoveryState {
  return {
    cycleId,
    revision: 1,
    chargedAttempts: 0,
  };
}

export function getMainSessionRecoveryRetryCount(
  state: MainRestartRecoveryState | undefined,
): number {
  return state ? state.chargedAttempts - (state.startedAttempt ?? 0) : 0;
}

function matchesObservation(
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

function hasCurrentForegroundClaim(
  state: MainRestartRecoveryState,
  lifecycleGeneration: string,
): boolean {
  return (
    state.foregroundClaims?.lifecycleGeneration === lifecycleGeneration &&
    state.foregroundClaims.tokens.length > 0
  );
}

function ownsForegroundClaim(
  state: MainRestartRecoveryState | undefined,
  claim: { cycleId: string; lifecycleGeneration: string; claimId: string },
): boolean {
  return (
    state?.cycleId === claim.cycleId &&
    state.foregroundClaims?.lifecycleGeneration === claim.lifecycleGeneration &&
    state.foregroundClaims.tokens.includes(claim.claimId)
  );
}

function validateRecoveryAdmission(
  entry: SessionEntry,
  command: {
    lifecycleGeneration: string;
    runId: string;
    sessionId: string;
  },
): MainSessionRecoveryConflict | null {
  const state = entry.mainRestartRecovery;
  if (entry.sessionId !== command.sessionId) {
    return "session_replaced";
  }
  if (entry.abortedLastRun !== true || !state) {
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

export function isMainSessionRecoveryPending(entry: SessionEntry, sessionKey: string): boolean {
  const state = entry.mainRestartRecovery;
  return (
    hasMainSessionRecoveryClaim(entry) &&
    entry.abortedLastRun === true &&
    isMainRestartRecoveryCandidate(entry, sessionKey) &&
    !state?.foregroundClaims &&
    !state?.reservation &&
    !state?.tombstone
  );
}

/** Failed foreground admission can leave an unfinished recovery cycle behind. */
export function isMainSessionRecoveryReconciliationCandidate(entry: SessionEntry): boolean {
  return (
    (entry.status === undefined || entry.status === "failed") &&
    entry.abortedLastRun !== true &&
    hasMainSessionRecoveryClaim(entry) &&
    !isRetryableUnadoptedChatClaim(entry) &&
    !entry.mainRestartRecovery?.tombstone
  );
}

/** A later foreground outcome cannot settle a different run's recovery fence. */
export function hasCompletedMainSessionRecoveryOutcome(entry: SessionEntry): boolean {
  return (
    isTerminalSessionStatus(entry.status) &&
    entry.status !== "interrupted" &&
    !isRetryableUnadoptedChatClaim(entry) &&
    !entry.pendingFinalDelivery &&
    (entry.restartRecoveryRuns ?? []).every((run) =>
      hasRestartRecoveryTerminalRun(entry, run.runId),
    )
  );
}

type MainRestartRecoveryRolloverEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: "already_recovered";
      recoveredSessionId?: string;
      recoveredSessionKey?: string;
    }
  | { eligible: false; reason: "not_tombstoned" };

export function inspectMainRestartRecoveryRolloverEligibility(
  entry: SessionEntry,
): MainRestartRecoveryRolloverEligibility {
  if (!entry.mainRestartRecovery?.tombstone) {
    return { eligible: false, reason: "not_tombstoned" };
  }
  const recoveredSessionId = entry.mainRestartRecovery.tombstone.recoveredSessionId;
  const recoveredSessionKey = entry.mainRestartRecovery.tombstone.recoveredSessionKey;
  if (recoveredSessionId || recoveredSessionKey) {
    return {
      eligible: false,
      reason: "already_recovered",
      ...(recoveredSessionId ? { recoveredSessionId } : {}),
      ...(recoveredSessionKey ? { recoveredSessionKey } : {}),
    };
  }
  return { eligible: true };
}

// Retire only proven terminal fences without remaining execution or delivery
// custody; treating unfinished fences as residue loses crash recovery (#118873).
export function isMainRestartRecoveryTerminalOnly(entry: SessionEntry): boolean {
  const state = entry.mainRestartRecovery;
  if (state?.tombstone || state?.reservation || state?.foregroundClaims) {
    return false;
  }
  if (entry.restartRecoveryDeliveryRunId !== undefined || entry.pendingFinalDelivery) {
    return false;
  }
  const runs = entry.restartRecoveryRuns;
  return (
    runs !== undefined &&
    runs.length > 0 &&
    runs.every((run) => hasRestartRecoveryTerminalRun(entry, run.runId))
  );
}

function inspectMainSessionRecovery(params: {
  entry: SessionEntry;
  lifecycleGeneration: string;
  sessionKey: string;
}): MainSessionRecoveryView {
  const { entry } = params;
  const state = entry.mainRestartRecovery;
  if (state?.tombstone) {
    return { status: "tombstoned" };
  }
  if (state && hasCurrentForegroundClaim(state, params.lifecycleGeneration)) {
    return { status: "blocked" };
  }
  if (
    entry.abortedLastRun !== true &&
    state &&
    entry.restartRecoveryRuns?.some((run) => run.lifecycleGeneration === params.lifecycleGeneration)
  ) {
    // Admission clears the interruption flag before the recovery run settles.
    // Keep ordinary work fenced until that run clears its lifecycle metadata.
    return { status: "blocked" };
  }
  if (
    entry.abortedLastRun !== true ||
    !isMainRestartRecoveryCandidate(entry, params.sessionKey) ||
    !state
  ) {
    return { status: "inactive" };
  }
  const observation = {
    sessionId: entry.sessionId,
    cycleId: state.cycleId,
    revision: state.revision,
  };
  if (state.reservation) {
    return { status: "blocked" };
  }
  const retryCount = getMainSessionRecoveryRetryCount(state);
  if (retryCount >= MAX_RECOVERY_RETRIES) {
    return {
      status: "exhausted",
      observation,
      reason:
        `main-session restart recovery blocked after ${retryCount} automatic attempts without a started runtime turn; ` +
        MAIN_RESTART_RECOVERY_REMEDIATION_HINT,
    };
  }
  return {
    status: "recoverable",
    observation,
    nextAttempt: state.chargedAttempts + 1,
  };
}

function inspectMainSessionRecoveryForAdmission(params: {
  entry: SessionEntry;
  lifecycleGeneration: string;
  sessionKey: string;
}): MainSessionRecoveryView {
  if (
    params.entry.abortedLastRun !== true &&
    params.entry.mainRestartRecovery &&
    params.entry.restartRecoveryRuns?.length &&
    !isMainRestartRecoveryTerminalOnly(params.entry)
  ) {
    // Standalone callers may use another process generation. An admitted
    // recovery fence remains authoritative until Gateway lifecycle settlement —
    // but a terminal-only aggregate owns nothing and must not wedge standalone
    // admission forever (#118873); the Gateway scan retires it durably.
    return { status: "blocked" };
  }
  if (
    hasMainSessionRecoveryClaim(params.entry) &&
    params.entry.abortedLastRun === true &&
    isMainRestartRecoveryCandidate(params.entry, params.sessionKey) &&
    !params.entry.mainRestartRecovery
  ) {
    // Only the Gateway owner may assign a cycle to an interrupted admission claim.
    return { status: "blocked" };
  }
  return inspectMainSessionRecovery(params);
}

export function transitionMainSessionRecovery(
  entry: SessionEntry,
  command: MainSessionRecoveryCommand,
): MainSessionRecoveryTransitionResult {
  switch (command.kind) {
    case "mark_interrupted": {
      const startedAt = entry.lifecycleRunId ? entry.startedAt : undefined;
      const preserveOutcome =
        (entry.status === undefined && entry.endedAt !== undefined) ||
        (isTerminalSessionStatus(entry.status) &&
          entry.status !== "interrupted" &&
          Boolean(entry.restartRecoveryDeliveryRunId || entry.pendingFinalDelivery));
      // Queued announcements add fences too. Retain the executing turn before
      // releasing its lifecycle identity so retries can join this recovery.
      entry.restartRecoveryDeliverySourceRunId ??=
        entry.restartRecoveryDeliveryRunId ?? entry.lifecycleRunId;
      const state = entry.mainRestartRecovery;
      if (!state) {
        entry.mainRestartRecovery = createCycle(command.cycleId);
      } else if (state.foregroundClaims || state.reservation) {
        // Restart owns continuation now. Process-bound foreground and reservation
        // leases cannot authorize the old lifecycle after this durable handoff.
        updateRecoveryState(entry, state, {
          foregroundClaims: undefined,
          reservation: undefined,
        });
      }
      entry.activeWriterRunId = undefined;
      entry.lifecycleRunId = undefined;
      entry.abortedLastRun = true;
      if (!preserveOutcome) {
        entry.status = "interrupted";
        entry.lastRunId = undefined;
        entry.startedAt = startedAt;
        entry.endedAt = command.now;
        entry.runtimeMs =
          typeof entry.startedAt === "number"
            ? Math.max(0, command.now - entry.startedAt)
            : undefined;
        entry.lastRunError = "Run interrupted by Gateway restart or loss.";
      }
      for (const run of command.runs ?? []) {
        recordLifecycleFence(entry, run);
      }
      entry.updatedAt = command.now;
      return { kind: "applied" };
    }
    case "inspect": {
      return {
        kind: "observed",
        view: inspectMainSessionRecoveryForAdmission({
          entry,
          lifecycleGeneration: command.lifecycleGeneration,
          sessionKey: command.sessionKey,
        }),
      };
    }
    case "observe": {
      if (
        hasMainSessionRecoveryClaim(entry) &&
        entry.abortedLastRun === true &&
        isMainRestartRecoveryCandidate(entry, command.sessionKey) &&
        !entry.mainRestartRecovery
      ) {
        // Acquire recovery identity before scanning interrupted rows.
        entry.mainRestartRecovery = createCycle(command.cycleId);
      }
      let state = entry.mainRestartRecovery;
      if (
        state?.foregroundClaims &&
        state.foregroundClaims.lifecycleGeneration !== command.lifecycleGeneration
      ) {
        // Process-local owners cannot survive a Gateway generation. Retire their
        // durable lease before the new process decides whether recovery is needed.
        if (entry.abortedLastRun !== true) {
          Object.assign(entry, buildMainSessionRecoveryClearPatch(entry));
          state = undefined;
        } else {
          state = updateRecoveryState(entry, state, { foregroundClaims: undefined });
        }
      }
      if (
        state?.reservation &&
        state.reservation.lifecycleGeneration !== command.lifecycleGeneration
      ) {
        // A process restart makes dispatch outcome unknowable: retain the charge,
        // but release the stale slot so the next bounded attempt can proceed.
        state = updateRecoveryState(entry, state, { reservation: undefined });
      }
      if (
        isMainRestartRecoveryTerminalOnly(entry) ||
        (hasCompletedMainSessionRecoveryOutcome(entry) &&
          !state?.tombstone &&
          !state?.reservation &&
          !(state && hasCurrentForegroundClaim(state, command.lifecycleGeneration)))
      ) {
        Object.assign(
          entry,
          buildMainSessionRecoverySettlementPatch({ entry, recordTerminalSource: true }),
        );
      }
      return {
        kind: "observed",
        view: inspectMainSessionRecovery({
          entry,
          lifecycleGeneration: command.lifecycleGeneration,
          sessionKey: command.sessionKey,
        }),
      };
    }
    case "prepare_attempt": {
      const conflict = matchesObservation(entry, command.observation);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const state = entry.mainRestartRecovery!;
      if (entry.abortedLastRun !== true) {
        return { kind: "rejected", reason: "not_interrupted" };
      }
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      if (state.reservation) {
        return { kind: "rejected", reason: "reservation_active" };
      }
      if (command.attempt !== state.chargedAttempts + 1) {
        return { kind: "rejected", reason: "stale_revision" };
      }
      updateRecoveryState(entry, state, {
        executionIdentity:
          command.executionIdentity.state === "enabled" && state.executionIdentity
            ? state.executionIdentity
            : undefined,
        chargedAttempts: command.attempt,
        reservation: {
          runId: command.runId,
          attempt: command.attempt,
          lifecycleGeneration: command.lifecycleGeneration,
        },
      });
      entry.updatedAt = command.now;
      return {
        kind: "reserved",
        reservation: {
          sessionId: entry.sessionId,
          cycleId: state.cycleId,
          lifecycleGeneration: command.lifecycleGeneration,
          runId: command.runId,
          attempt: command.attempt,
        },
      };
    }
    case "bind_admitted_execution_identity":
    case "register_recovery_turn": {
      const state = entry.mainRestartRecovery;
      if (
        !state ||
        state.cycleId !== command.cycleId ||
        // Keep attempt identity monotonic across successful starts. Resetting the
        // counter itself would let delayed admission callbacks match newer work.
        state.chargedAttempts !== command.attempt ||
        entry.sessionId !== command.sessionId ||
        entry.lifecycleRunId !== command.runId ||
        !entry.restartRecoveryRuns?.some(
          (run) =>
            run.runId === command.runId && run.lifecycleGeneration === command.lifecycleGeneration,
        )
      ) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      if (command.kind === "register_recovery_turn") {
        if (state.startedAttempt === command.attempt) {
          return { kind: "no_change" };
        }
        updateRecoveryState(entry, state, { startedAttempt: command.attempt });
      } else {
        if (state.executionIdentity) {
          return JSON.stringify(state.executionIdentity) === JSON.stringify(command.token)
            ? { kind: "no_change" }
            : { kind: "rejected", reason: "stale_reservation" };
        }
        if (command.token.runId !== command.runId) {
          return { kind: "rejected", reason: "stale_reservation" };
        }
        updateRecoveryState(entry, state, { executionIdentity: command.token });
      }
      return { kind: "applied" };
    }
    case "cancel_reservation":
    case "abandon_reservation": {
      const state = entry.mainRestartRecovery;
      const reserved = state?.reservation;
      if (
        !state ||
        entry.sessionId !== command.reservation.sessionId ||
        state.cycleId !== command.reservation.cycleId ||
        reserved?.runId !== command.reservation.runId ||
        reserved.attempt !== command.reservation.attempt ||
        reserved.lifecycleGeneration !== command.reservation.lifecycleGeneration
      ) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      updateRecoveryState(entry, state, {
        chargedAttempts:
          command.kind === "cancel_reservation"
            ? Math.max(0, command.reservation.attempt - 1)
            : state.chargedAttempts,
        reservation: undefined,
      });
      return { kind: "applied" };
    }
    case "validate_recovery": {
      const conflict = validateRecoveryAdmission(entry, command);
      return conflict ? { kind: "rejected", reason: conflict } : { kind: "recovery_validated" };
    }
    case "admit_recovery": {
      const conflict = validateRecoveryAdmission(entry, command);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const state = entry.mainRestartRecovery!;
      updateRecoveryState(entry, state, {
        reservation: undefined,
        foregroundClaims: undefined,
      });
      entry.abortedLastRun = false;
      entry.status = undefined;
      entry.endedAt = undefined;
      entry.runtimeMs = undefined;
      entry.lastRunError = undefined;
      entry.lifecycleRunId = command.runId;
      entry.lastRunId = undefined;
      recordLifecycleFence(entry, {
        runId: command.runId,
        lifecycleGeneration: command.lifecycleGeneration,
      });
      if (entry.pendingFinalDelivery?.kind === "replayable") {
        const pendingText = sanitizePendingFinalDeliveryText(entry.pendingFinalDelivery.text);
        if (pendingText) {
          entry.pendingFinalDelivery = { ...entry.pendingFinalDelivery, text: pendingText };
        } else {
          Object.assign(entry, PENDING_FINAL_DELIVERY_CLEAR_PATCH);
        }
      }
      return {
        kind: "admitted_recovery",
        admission: {
          cycleId: state.cycleId,
          attempt: state.chargedAttempts,
          lifecycleGeneration: command.lifecycleGeneration,
          runId: command.runId,
          sessionId: command.sessionId,
        },
      };
    }
    case "mark_admitted_recovery_interrupted": {
      const state = entry.mainRestartRecovery;
      if (entry.sessionId !== command.sessionId) {
        return { kind: "rejected", reason: "session_replaced" };
      }
      if (
        !state ||
        state.cycleId !== command.cycleId ||
        state.chargedAttempts !== command.attempt ||
        state.reservation ||
        state.foregroundClaims ||
        !entry.restartRecoveryRuns?.some(
          (run) =>
            run.runId === command.runId && run.lifecycleGeneration === command.lifecycleGeneration,
        )
      ) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      if (entry.lifecycleRunId !== command.runId) {
        // A committed restoration may lose its response. Only that exact pending
        // attempt is repeatable; retained run fences do not authorize newer work.
        return entry.abortedLastRun === true &&
          entry.lifecycleRunId === undefined &&
          entry.restartRecoveryDeliveryRunId === undefined
          ? { kind: "no_change" }
          : { kind: "rejected", reason: "stale_reservation" };
      }
      entry.status = "interrupted";
      entry.lifecycleRunId = undefined;
      entry.lastRunId = undefined;
      entry.abortedLastRun = true;
      entry.startedAt = undefined;
      entry.endedAt = command.now;
      entry.lastRunError = "Run interrupted before restart recovery could start.";
      entry.runtimeMs = undefined;
      if (entry.restartRecoveryDeliveryRunId === command.runId) {
        // Rotate the failed RPC id on retry so dedupe cannot replay its terminal failure.
        entry.restartRecoveryDeliveryRunId = undefined;
      }
      entry.updatedAt = command.now;
      return { kind: "applied" };
    }
    case "claim_foreground": {
      if (
        entry.sessionId === command.sessionId &&
        isMainRestartRecoveryCandidate(entry, command.sessionKey) &&
        isMainRestartRecoveryTerminalOnly(entry)
      ) {
        Object.assign(entry, buildMainSessionRecoveryClearPatch(entry));
        return { kind: "applied" };
      }
      if (
        entry.sessionId !== command.sessionId ||
        !hasMainSessionRecoveryClaim(entry) ||
        entry.abortedLastRun !== true ||
        !isMainRestartRecoveryCandidate(entry, command.sessionKey)
      ) {
        return { kind: "no_change" };
      }
      const state = entry.mainRestartRecovery ?? createCycle(command.cycleId);
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      if (getMainSessionRecoveryRetryCount(state) >= MAX_RECOVERY_RETRIES) {
        // The final charge fences foreground work until the scheduler commits
        // the matching tombstone. Admitting here can race that reconciliation.
        return { kind: "rejected", reason: "recovery_exhausted" };
      }
      const currentClaims =
        state.foregroundClaims?.lifecycleGeneration === command.lifecycleGeneration
          ? state.foregroundClaims
          : undefined;
      const tokens = [...new Set([...(currentClaims?.tokens ?? []), command.claimId])].toSorted();
      const runIdsByClaimId = command.runId
        ? { ...currentClaims?.runIdsByClaimId, [command.claimId]: command.runId }
        : currentClaims?.runIdsByClaimId;
      if (command.runId) {
        recordLifecycleFence(entry, {
          lifecycleGeneration: command.lifecycleGeneration,
          runId: command.runId,
        });
      }
      updateRecoveryState(entry, state, {
        reservation:
          state.reservation?.lifecycleGeneration === command.lifecycleGeneration
            ? state.reservation
            : undefined,
        foregroundClaims: {
          lifecycleGeneration: command.lifecycleGeneration,
          tokens,
          ...(runIdsByClaimId ? { runIdsByClaimId } : {}),
        },
      });
      return {
        kind: "foreground_claimed",
        claim: {
          cycleId: state.cycleId,
          lifecycleGeneration: command.lifecycleGeneration,
          claimId: command.claimId,
          sessionId: entry.sessionId,
          sessionKey: command.sessionKey,
          ...(command.runId ? { runId: command.runId } : {}),
        },
      };
    }
    case "bind_foreground_run": {
      const state = entry.mainRestartRecovery;
      const claims = state?.foregroundClaims;
      if (!state || !claims || !ownsForegroundClaim(state, command.claim)) {
        return { kind: "no_change" };
      }
      recordLifecycleFence(entry, {
        lifecycleGeneration: command.claim.lifecycleGeneration,
        runId: command.runId,
      });
      updateRecoveryState(entry, state, {
        foregroundClaims: {
          ...claims,
          runIdsByClaimId: { ...claims.runIdsByClaimId, [command.claim.claimId]: command.runId },
        },
      });
      return { kind: "applied" };
    }
    case "validate_foreground": {
      const state = entry.mainRestartRecovery;
      return entry.sessionId === command.claim.sessionId &&
        ownsForegroundClaim(state, command.claim)
        ? { kind: "foreground_validated" }
        : { kind: "no_change" };
    }
    case "release_foreground": {
      const state = entry.mainRestartRecovery;
      const claims = state?.foregroundClaims;
      if (!state || !claims || !ownsForegroundClaim(state, command.claim)) {
        return { kind: "no_change" };
      }
      const foregroundClaims = removeMainSessionRecoveryForegroundClaim(
        claims,
        command.claim.claimId,
      );
      if (!foregroundClaims && entry.abortedLastRun !== true) {
        Object.assign(entry, buildMainSessionRecoveryClearPatch(entry));
        return { kind: "applied" };
      }
      updateRecoveryState(entry, state, { foregroundClaims });
      return { kind: "applied" };
    }
    case "tombstone": {
      const conflict = matchesObservation(entry, command.observation);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const state = entry.mainRestartRecovery!;
      if (state.reservation) {
        return { kind: "rejected", reason: "reservation_active" };
      }
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      updateRecoveryState(entry, state, {
        tombstone: {
          reason: command.reason,
        },
      });
      entry.abortedLastRun = false;
      entry.status = "failed";
      entry.lifecycleRunId = undefined;
      entry.lastRunId = resolveRestartRecoveryTerminalClientRunId(entry);
      entry.endedAt = command.now;
      entry.runtimeMs = Math.max(0, command.now - (entry.startedAt ?? command.now));
      entry.updatedAt = command.now;
      return { kind: "tombstoned" };
    }
    case "doctor_repair": {
      if (!entry.mainRestartRecovery?.tombstone || entry.abortedLastRun !== true) {
        return { kind: "no_change" };
      }
      entry.abortedLastRun = false;
      entry.updatedAt = command.now;
      return { kind: "doctor_repaired" };
    }
    case "clear": {
      const patch = buildMainSessionRecoveryClearPatch(entry);
      if (Object.keys(patch).length === 0) {
        return { kind: "no_change" };
      }
      Object.assign(entry, patch);
      return { kind: "applied" };
    }
    default:
      return command satisfies never;
  }
}
