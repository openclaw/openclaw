import { randomUUID } from "node:crypto";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/main-session-recovery.types.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { retryAsync } from "../infra/retry.js";
import {
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
  transition: MainSessionRecoveryTransitionResult;
};

type MainSessionRecoveryOwnerClaimResult =
  | { kind: "claimed"; lease: MainSessionRecoveryOwnerLease }
  | { kind: "invalidated"; reason: string }
  | { kind: "not_required" };

function transitionChanged(result: MainSessionRecoveryTransitionResult): boolean {
  return result.kind !== "no_change" && result.kind !== "observed" && result.kind !== "rejected";
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
    default:
      return undefined;
  }
}

export async function commitMainSessionRecovery(params: {
  command: MainSessionRecoveryCommand;
  requireWriteSuccess?: boolean;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryStoreResult> {
  const cancellation =
    params.command.kind === "cancel_reservation" ? params.command.reservation : undefined;
  const recoveryAdmission =
    params.command.kind === "admit_recovery" || params.command.kind === "validate_recovery"
      ? params.command
      : undefined;
  const ownerClaim = params.command.kind === "claim_foreground" ? params.command : undefined;
  const ownerRelease =
    params.command.kind === "release_foreground" ? params.command.claim : undefined;
  const scansAliases = Boolean(cancellation || recoveryAdmission || ownerClaim || ownerRelease);
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
      let candidate = selected;
      if (cancellation) {
        candidate =
          entries.find(({ entry }) => matchesReservation(entry, cancellation)) ?? selected;
      } else if (recoveryAdmission) {
        // Canonical session-key migration may happen between reservation and
        // Gateway admission; the reservation identity remains authoritative.
        candidate =
          entries.find(({ entry }) => matchesRecoveryAdmission(entry, recoveryAdmission)) ??
          selected;
      } else if (ownerRelease) {
        candidate = entries.find(({ entry }) => matchesOwnerClaim(entry, ownerRelease)) ?? selected;
      } else if (ownerClaim && !selected) {
        candidate = entries.find(({ entry }) => entry.sessionId === ownerClaim.sessionId);
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
      const command =
        ownerClaim && ownerClaim.sessionKey !== candidate.sessionKey
          ? { ...ownerClaim, sessionKey: candidate.sessionKey }
          : params.command;
      const transition = transitionMainSessionRecovery(entry, command);
      const changed =
        transitionChanged(transition) || previousRecoveryState !== entry.mainRestartRecovery;
      return {
        result: { entry, transition },
        ...(changed ? { replacements: [{ sessionKey: candidate.sessionKey, entry }] } : {}),
      };
    },
  });
}

export async function claimMainSessionRecoveryOwner(params: {
  lifecycleGeneration: string;
  sessionId: string;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryOwnerClaimResult> {
  const claim = await commitMainSessionRecovery({
    command: {
      kind: "claim_foreground",
      cycleId: randomUUID(),
      lifecycleGeneration: params.lifecycleGeneration,
      sessionId: params.sessionId,
      sessionKey: params.target.sessionKey,
      claimId: randomUUID(),
    },
    requireWriteSuccess: true,
    target: params.target,
  });
  if (claim.transition.kind === "foreground_claimed") {
    return {
      kind: "claimed",
      lease: { ...claim.transition.claim, storePath: params.target.storePath },
    };
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

export async function releaseMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease | undefined,
): Promise<void> {
  if (!lease) {
    return;
  }
  // A leaked current-generation token blocks automatic recovery until restart.
  // Token-scoped release is idempotent, so transient writer failures are safe to retry.
  await retryAsync(
    async () =>
      await commitMainSessionRecovery({
        command: { kind: "release_foreground", claim: lease },
        requireWriteSuccess: true,
        target: lease,
      }),
    3,
    25,
  );
}
