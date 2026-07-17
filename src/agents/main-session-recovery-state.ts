import {
  PENDING_FINAL_DELIVERY_CLEAR_PATCH,
  sanitizePendingFinalDeliveryText,
} from "../auto-reply/reply/pending-final-delivery.js";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
  RestartRecoveryRun,
} from "../config/sessions.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryConflict,
  MainSessionRecoveryObservation,
  MainSessionRecoveryTransitionResult,
  MainSessionRecoveryView,
} from "./main-session-recovery-types.js";

export type {
  MainSessionRecoveryCommand,
  MainSessionRecoveryObservation,
  MainSessionRecoveryOwnerClaim,
  MainSessionRecoveryReservation,
  MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-types.js";

const MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 3;

const MAIN_RESTART_RECOVERY_REMEDIATION_HINT =
  "inspect the failed main session and use /new or reset to start a replacement session";

function nextRevision(state: MainRestartRecoveryState): number {
  return state.revision + 1;
}

function createCycle(cycleId: string): MainRestartRecoveryState {
  return {
    cycleId,
    revision: 1,
    chargedAttempts: 0,
  };
}

function observationFor(entry: SessionEntry): MainSessionRecoveryObservation | undefined {
  const state = entry.mainRestartRecovery;
  if (!state) {
    return undefined;
  }
  return {
    sessionId: entry.sessionId,
    cycleId: state.cycleId,
    revision: state.revision,
  };
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
  if (entry.status !== "running" || entry.abortedLastRun !== true || !state) {
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

function recordLifecycleFence(entry: SessionEntry, run: RestartRecoveryRun): void {
  // Lifecycle fences can overlap and are consumed independently by their matching events.
  const runs = new Map<string, RestartRecoveryRun>();
  for (const existing of entry.restartRecoveryRuns ?? []) {
    runs.set(`${existing.runId}\u0000${existing.lifecycleGeneration}`, existing);
  }
  runs.set(`${run.runId}\u0000${run.lifecycleGeneration}`, run);
  entry.restartRecoveryRuns = [...runs.values()].toSorted((a, b) =>
    a.runId === b.runId
      ? a.lifecycleGeneration.localeCompare(b.lifecycleGeneration)
      : a.runId.localeCompare(b.runId),
  );
}

function hasLifecycleFence(entry: SessionEntry, run: RestartRecoveryRun): boolean {
  return Boolean(
    entry.restartRecoveryRuns?.some(
      (candidate) =>
        candidate.runId === run.runId && candidate.lifecycleGeneration === run.lifecycleGeneration,
    ),
  );
}

function formatAttemptBudgetReason(attempts: number): string {
  return (
    `main-session restart recovery blocked after ${attempts} charged automatic resume attempts; ` +
    MAIN_RESTART_RECOVERY_REMEDIATION_HINT
  );
}

export function isMainRestartRecoveryCandidate(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return false;
  }
  if (entry.subagentRole != null) {
    return false;
  }
  return (
    !isSubagentSessionKey(sessionKey) &&
    !isCronSessionKey(sessionKey) &&
    !isAcpSessionKey(sessionKey)
  );
}

function inspectMainSessionRecovery(params: {
  entry: SessionEntry;
  lifecycleGeneration: string;
  sessionKey: string;
}): MainSessionRecoveryView {
  const { entry } = params;
  if (
    entry.status !== "running" ||
    entry.abortedLastRun !== true ||
    !isMainRestartRecoveryCandidate(entry, params.sessionKey)
  ) {
    return { status: "inactive" };
  }
  const state = entry.mainRestartRecovery;
  const observation = observationFor(entry);
  if (!state || !observation) {
    return { status: "inactive" };
  }
  if (state.tombstone) {
    return { status: "tombstoned" };
  }
  if (hasCurrentForegroundClaim(state, params.lifecycleGeneration)) {
    return { status: "blocked" };
  }
  if (state.reservation) {
    return { status: "blocked" };
  }
  if (state.chargedAttempts >= MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) {
    return {
      status: "exhausted",
      observation,
      reason: formatAttemptBudgetReason(state.chargedAttempts),
    };
  }
  return {
    status: "recoverable",
    observation,
    nextAttempt: state.chargedAttempts + 1,
  };
}

export function transitionMainSessionRecovery(
  entry: SessionEntry,
  command: MainSessionRecoveryCommand,
): MainSessionRecoveryTransitionResult {
  switch (command.kind) {
    case "mark_interrupted": {
      if (!entry.mainRestartRecovery) {
        entry.mainRestartRecovery = createCycle(command.cycleId);
      }
      entry.status = "running";
      entry.abortedLastRun = true;
      if (command.resetRuntime) {
        entry.startedAt = undefined;
        entry.endedAt = undefined;
        entry.runtimeMs = undefined;
      }
      for (const run of command.runs ?? []) {
        recordLifecycleFence(entry, run);
      }
      entry.updatedAt = command.now;
      return { kind: "applied" };
    }
    case "observe": {
      if (
        entry.status === "running" &&
        entry.abortedLastRun === true &&
        isMainRestartRecoveryCandidate(entry, command.sessionKey) &&
        !entry.mainRestartRecovery
      ) {
        // Rows interrupted by an older shipped version acquire identity before scanning.
        entry.mainRestartRecovery = createCycle(command.cycleId);
      }
      const state = entry.mainRestartRecovery;
      if (
        state?.reservation &&
        state.reservation.lifecycleGeneration !== command.lifecycleGeneration
      ) {
        // A process restart makes dispatch outcome unknowable: retain the charge,
        // but release the stale slot so the next bounded attempt can proceed.
        entry.mainRestartRecovery = {
          ...state,
          revision: nextRevision(state),
          reservation: undefined,
        };
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
      if (entry.status !== "running" || entry.abortedLastRun !== true) {
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
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        chargedAttempts: command.attempt,
        reservation: {
          runId: command.runId,
          attempt: command.attempt,
          lifecycleGeneration: command.lifecycleGeneration,
        },
      };
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
    case "cancel_reservation": {
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
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        chargedAttempts: Math.max(0, command.reservation.attempt - 1),
        reservation: undefined,
      };
      return { kind: "applied" };
    }
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
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        reservation: undefined,
      };
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
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        reservation: undefined,
        foregroundClaims: undefined,
      };
      entry.abortedLastRun = false;
      recordLifecycleFence(entry, {
        runId: command.runId,
        lifecycleGeneration: command.lifecycleGeneration,
      });
      if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
        const pendingText = sanitizePendingFinalDeliveryText(entry.pendingFinalDeliveryText ?? "");
        if (pendingText) {
          entry.pendingFinalDeliveryLastAttemptAt = command.now;
          entry.pendingFinalDeliveryAttemptCount =
            (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
          entry.pendingFinalDeliveryLastError = null;
          entry.pendingFinalDeliveryText = pendingText;
        } else {
          Object.assign(entry, PENDING_FINAL_DELIVERY_CLEAR_PATCH);
        }
      }
      return { kind: "admitted_recovery" };
    }
    case "mark_admitted_recovery_interrupted": {
      const state = entry.mainRestartRecovery;
      if (entry.sessionId !== command.sessionId) {
        return { kind: "rejected", reason: "session_replaced" };
      }
      if (
        !state ||
        state.reservation ||
        !hasLifecycleFence(entry, {
          runId: command.runId,
          lifecycleGeneration: command.lifecycleGeneration,
        })
      ) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      entry.status = "running";
      entry.abortedLastRun = true;
      entry.startedAt = undefined;
      entry.endedAt = undefined;
      entry.runtimeMs = undefined;
      if (entry.restartRecoveryDeliveryRunId === command.runId) {
        // Gateway accepted this RPC id before setup failed. Rotate it on retry
        // or the dedupe cache replays that terminal pre-dispatch failure.
        entry.restartRecoveryDeliveryRunId = undefined;
      }
      entry.updatedAt = command.now;
      return { kind: "applied" };
    }
    case "claim_foreground": {
      if (
        entry.sessionId !== command.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        !isMainRestartRecoveryCandidate(entry, command.sessionKey)
      ) {
        return { kind: "no_change" };
      }
      const state = entry.mainRestartRecovery ?? createCycle(command.cycleId);
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      const currentTokens =
        state.foregroundClaims?.lifecycleGeneration === command.lifecycleGeneration
          ? state.foregroundClaims.tokens
          : [];
      const tokens = [...new Set([...currentTokens, command.claimId])].toSorted();
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        foregroundClaims: {
          lifecycleGeneration: command.lifecycleGeneration,
          tokens,
        },
      };
      return {
        kind: "foreground_claimed",
        claim: {
          cycleId: state.cycleId,
          lifecycleGeneration: command.lifecycleGeneration,
          claimId: command.claimId,
          sessionId: entry.sessionId,
          sessionKey: command.sessionKey,
        },
      };
    }
    case "validate_foreground": {
      const state = entry.mainRestartRecovery;
      const claims = state?.foregroundClaims;
      return entry.sessionId === command.claim.sessionId &&
        state?.cycleId === command.claim.cycleId &&
        claims?.lifecycleGeneration === command.claim.lifecycleGeneration &&
        claims.tokens.includes(command.claim.claimId)
        ? { kind: "foreground_validated" }
        : { kind: "no_change" };
    }
    case "release_foreground": {
      const state = entry.mainRestartRecovery;
      const claims = state?.foregroundClaims;
      if (
        !state ||
        state.cycleId !== command.claim.cycleId ||
        claims?.lifecycleGeneration !== command.claim.lifecycleGeneration ||
        !claims.tokens.includes(command.claim.claimId)
      ) {
        return { kind: "no_change" };
      }
      const tokens = claims.tokens.filter((token) => token !== command.claim.claimId);
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        foregroundClaims:
          tokens.length > 0
            ? { lifecycleGeneration: command.claim.lifecycleGeneration, tokens }
            : undefined,
      };
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
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        tombstone: {
          reason: command.reason,
        },
      };
      entry.abortedLastRun = false;
      entry.status = "failed";
      entry.endedAt = command.now;
      entry.runtimeMs = Math.max(0, command.now - (entry.startedAt ?? command.now));
      entry.updatedAt = command.now;
      return { kind: "tombstoned" };
    }
    case "fail_recovery": {
      const conflict = matchesObservation(entry, command.observation);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const noticeEntry = structuredClone(entry);
      entry.status = "failed";
      entry.abortedLastRun = true;
      entry.endedAt = command.now;
      entry.updatedAt = command.now;
      Object.assign(entry, PENDING_FINAL_DELIVERY_CLEAR_PATCH);
      Object.assign(
        entry,
        buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
        }),
      );
      entry.mainRestartRecovery = undefined;
      return { kind: "failed", noticeEntry };
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
