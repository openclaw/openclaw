import { randomUUID } from "node:crypto";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { retryAsync } from "../infra/retry.js";
import {
  isMainRestartRecoveryCandidate,
  transitionMainSessionRecovery,
  type MainSessionRecoveryCommand,
  type MainSessionRecoveryOwnerClaim,
  type MainSessionRecoveryReservation,
  type MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-state.js";

type MainSessionRecoveryStoreTarget = {
  sessionKey: string;
  storePath: string;
};

export type MainSessionRecoveryOwnerLease = MainSessionRecoveryOwnerClaim &
  MainSessionRecoveryStoreTarget;

type MainSessionRecoveryStoreResult = {
  entry?: SessionEntry;
  sessionKey?: string;
  transition: MainSessionRecoveryTransitionResult;
};

export type MainSessionRecoveryPendingTarget = MainSessionRecoveryStoreTarget & {
  sessionId: string;
};

type MainSessionRecoveryOwnerClaimResult =
  | { kind: "claimed"; lease: MainSessionRecoveryOwnerLease }
  | { kind: "invalidated"; reason: string }
  | { kind: "not_required" };

type MainSessionRecoveryInspectionResult =
  | { kind: "invalidated"; reason: string }
  | { kind: "not_required" }
  | { kind: "required" };

function transitionChanged(result: MainSessionRecoveryTransitionResult): boolean {
  return (
    result.kind !== "foreground_validated" &&
    result.kind !== "no_change" &&
    result.kind !== "observed" &&
    result.kind !== "rejected"
  );
}

function matchesReservation(entry: SessionEntry, reservation: MainSessionRecoveryReservation) {
  const state = entry.mainRestartRecovery;
  return (
    entry.sessionId === reservation.sessionId &&
    state?.cycleId === reservation.cycleId &&
    state.reservation?.runId === reservation.runId &&
    state.reservation.lifecycleGeneration === reservation.lifecycleGeneration
  );
}

function matchesRecoveryAdmission(
  entry: SessionEntry,
  command: Extract<MainSessionRecoveryCommand, { kind: "admit_recovery" | "validate_recovery" }>,
): boolean {
  const reservation = entry.mainRestartRecovery?.reservation;
  return (
    entry.sessionId === command.sessionId &&
    reservation?.runId === command.runId &&
    reservation.lifecycleGeneration === command.lifecycleGeneration
  );
}

function matchesOwnerClaim(entry: SessionEntry, claim: MainSessionRecoveryOwnerClaim): boolean {
  const state = entry.mainRestartRecovery;
  return (
    state?.cycleId === claim.cycleId &&
    state.foregroundClaims?.lifecycleGeneration === claim.lifecycleGeneration &&
    state.foregroundClaims.tokens.includes(claim.claimId)
  );
}

function currentGenerationRequiredBy(command: MainSessionRecoveryCommand): string | undefined {
  // Generation gates new decisions. Exact reservation/token cleanup must remain
  // valid after a restart so the old owner cannot leak its slot or claim.
  switch (command.kind) {
    case "admit_recovery":
    case "claim_foreground":
    case "mark_admitted_recovery_interrupted":
    case "observe":
    case "prepare_attempt":
    case "validate_recovery":
      return command.lifecycleGeneration;
    case "validate_foreground":
      return command.claim.lifecycleGeneration;
    default:
      return undefined;
  }
}

export async function commitMainSessionRecovery(params: {
  command: MainSessionRecoveryCommand;
  expectedSessionId?: string;
  requireWriteSuccess?: boolean;
  scanAliases?: boolean;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryStoreResult> {
  const cancellation =
    params.command.kind === "cancel_reservation" ? params.command.reservation : undefined;
  const abandonment =
    params.command.kind === "abandon_reservation" ? params.command.reservation : undefined;
  const recoveryAdmission =
    params.command.kind === "admit_recovery" || params.command.kind === "validate_recovery"
      ? params.command
      : undefined;
  const ownerClaim = params.command.kind === "claim_foreground" ? params.command : undefined;
  const ownerValidation =
    params.command.kind === "validate_foreground" ? params.command.claim : undefined;
  const ownerRelease =
    params.command.kind === "release_foreground" ? params.command.claim : undefined;
  const reservationCleanup = cancellation ?? abandonment;
  const scansAliases = Boolean(
    params.scanAliases ||
    reservationCleanup ||
    recoveryAdmission ||
    ownerValidation ||
    ownerRelease,
  );
  return await applySessionEntryReplacements<MainSessionRecoveryStoreResult>({
    requireWriteSuccess: params.requireWriteSuccess,
    ...(scansAliases ? {} : { sessionKeys: [params.target.sessionKey] }),
    storePath: params.target.storePath,
    update: (entries) => {
      const expectedGeneration = currentGenerationRequiredBy(params.command);
      if (expectedGeneration && expectedGeneration !== getAgentEventLifecycleGeneration()) {
        return {
          result: {
            transition: { kind: "rejected", reason: "stale_generation" },
          },
        };
      }
      const selected = entries.find(({ sessionKey }) => sessionKey === params.target.sessionKey);
      let candidate =
        params.expectedSessionId && selected?.entry.sessionId !== params.expectedSessionId
          ? undefined
          : selected;
      if (reservationCleanup) {
        candidate =
          entries.find(({ entry }) => matchesReservation(entry, reservationCleanup)) ?? selected;
      } else if (recoveryAdmission) {
        // Canonical session-key migration may happen between reservation and
        // Gateway admission; the reservation identity remains authoritative.
        candidate =
          entries.find(({ entry }) => matchesRecoveryAdmission(entry, recoveryAdmission)) ??
          selected;
      } else if (ownerValidation || ownerRelease) {
        const exactClaim = ownerValidation ?? ownerRelease!;
        candidate = entries.find(({ entry }) => matchesOwnerClaim(entry, exactClaim)) ?? selected;
      } else if (ownerClaim && !selected) {
        candidate = entries.find(({ entry }) => entry.sessionId === ownerClaim.sessionId);
      } else if (params.scanAliases && params.expectedSessionId) {
        candidate = entries.find(({ entry }) => entry.sessionId === params.expectedSessionId);
      }
      if (!candidate) {
        return {
          result: {
            transition: { kind: "rejected", reason: "session_replaced" },
          },
        };
      }
      const entry = candidate.entry as SessionEntry;
      const previousRecoveryState = entry.mainRestartRecovery;
      let command: MainSessionRecoveryCommand;
      if (ownerClaim) {
        command =
          ownerClaim.sessionKey === candidate.sessionKey
            ? ownerClaim
            : { ...ownerClaim, sessionKey: candidate.sessionKey };
      } else if (
        params.command.kind === "observe" &&
        params.command.sessionKey !== candidate.sessionKey
      ) {
        command = { ...params.command, sessionKey: candidate.sessionKey };
      } else {
        command = params.command;
      }
      const transition = transitionMainSessionRecovery(entry, command);
      const changed =
        transitionChanged(transition) || previousRecoveryState !== entry.mainRestartRecovery;
      return {
        result: { entry, sessionKey: candidate.sessionKey, transition },
        ...(changed ? { replacements: [{ sessionKey: candidate.sessionKey, entry }] } : {}),
      };
    },
  });
}

export async function validateMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease,
): Promise<boolean> {
  const result = await commitMainSessionRecovery({
    command: { kind: "validate_foreground", claim: lease },
    requireWriteSuccess: true,
    target: lease,
  });
  return result.transition.kind === "foreground_validated";
}

export async function claimMainSessionRecoveryOwner(params: {
  allowMissingSession?: boolean;
  lifecycleGeneration: string;
  replacementSessionId?: string;
  sessionId: string;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryOwnerClaimResult> {
  const command = {
    kind: "claim_foreground" as const,
    cycleId: randomUUID(),
    lifecycleGeneration: params.lifecycleGeneration,
    sessionId: params.sessionId,
    sessionKey: params.target.sessionKey,
    claimId: randomUUID(),
  };
  let claim = await commitMainSessionRecovery({
    command,
    requireWriteSuccess: true,
    target: params.target,
  });
  if (claim.transition.kind === "rejected" && claim.transition.reason === "session_replaced") {
    claim = await commitMainSessionRecovery({
      command,
      requireWriteSuccess: true,
      scanAliases: true,
      target: params.target,
    });
  }
  if (claim.transition.kind === "foreground_claimed") {
    return {
      kind: "claimed",
      lease: { ...claim.transition.claim, storePath: params.target.storePath },
    };
  }
  if (claim.transition.kind === "rejected" && claim.transition.reason === "stale_generation") {
    return { kind: "invalidated", reason: claim.transition.reason };
  }
  if (!claim.entry && (params.allowMissingSession || params.replacementSessionId)) {
    // A fresh explicit session has no predecessor. An automatic rollover can
    // also lose its predecessor before admission. Either way, no row remains to fence.
    return { kind: "not_required" };
  }
  if (
    params.replacementSessionId &&
    claim.entry?.sessionId === params.replacementSessionId &&
    claim.entry.abortedLastRun !== true &&
    claim.entry.restartRecoveryRuns === undefined &&
    claim.entry.mainRestartRecovery === undefined
  ) {
    return { kind: "not_required" };
  }
  if (
    claim.entry?.sessionId === params.sessionId &&
    claim.sessionKey &&
    !isMainRestartRecoveryCandidate(claim.entry, claim.sessionKey)
  ) {
    return { kind: "not_required" };
  }
  if (
    claim.entry?.sessionId === params.sessionId &&
    claim.entry.abortedLastRun !== true &&
    claim.entry.restartRecoveryRuns === undefined &&
    claim.entry.mainRestartRecovery === undefined
  ) {
    // A healthy completion may clear recovery between the caller's read and this
    // transaction. Only that fully clean same-session state can proceed unclaimed.
    return { kind: "not_required" };
  }
  const reason = claim.transition.kind === "rejected" ? claim.transition.reason : "state_changed";
  return { kind: "invalidated", reason };
}

export async function inspectMainSessionRecoveryRequired(params: {
  expectedSessionId: string;
  lifecycleGeneration: string;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryInspectionResult> {
  const command = {
    kind: "observe" as const,
    cycleId: randomUUID(),
    lifecycleGeneration: params.lifecycleGeneration,
    sessionKey: params.target.sessionKey,
  };
  let result = await commitMainSessionRecovery({
    command,
    expectedSessionId: params.expectedSessionId,
    requireWriteSuccess: true,
    target: params.target,
  });
  if (result.transition.kind === "rejected" && result.transition.reason === "session_replaced") {
    result = await commitMainSessionRecovery({
      command,
      expectedSessionId: params.expectedSessionId,
      requireWriteSuccess: true,
      scanAliases: true,
      target: params.target,
    });
  }
  if (result.transition.kind === "observed") {
    return result.transition.view.status === "inactive"
      ? { kind: "not_required" }
      : { kind: "required" };
  }
  if (result.transition.kind === "rejected" && result.transition.reason === "session_replaced") {
    return { kind: "not_required" };
  }
  return {
    kind: "invalidated",
    reason: result.transition.kind === "rejected" ? result.transition.reason : "state_changed",
  };
}

export async function releaseMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease | undefined,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  if (!lease) {
    return undefined;
  }
  // A leaked current-generation token blocks automatic recovery until restart.
  // Token-scoped release is idempotent, so transient writer failures are safe to retry.
  const released = await retryAsync(
    async () =>
      await commitMainSessionRecovery({
        command: { kind: "release_foreground", claim: lease },
        requireWriteSuccess: true,
        target: lease,
      }),
    3,
    25,
  );
  const { entry, sessionKey } = released;
  const state = entry?.mainRestartRecovery;
  if (
    released.transition.kind !== "applied" ||
    !entry ||
    !sessionKey ||
    entry.sessionId !== lease.sessionId ||
    entry.status !== "running" ||
    entry.abortedLastRun !== true ||
    !isMainRestartRecoveryCandidate(entry, sessionKey) ||
    state?.foregroundClaims ||
    state?.reservation ||
    state?.tombstone
  ) {
    return undefined;
  }
  return { sessionId: entry.sessionId, sessionKey, storePath: lease.storePath };
}
