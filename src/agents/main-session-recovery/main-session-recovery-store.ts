import { randomUUID } from "node:crypto";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  retryMainSessionRecoveryMutation,
  scheduleMainSessionRecoveryMutation,
} from "./main-session-recovery-lifecycle.js";
import {
  isMainRestartRecoveryCandidate,
  isMainSessionRecoveryPending,
  transitionMainSessionRecovery,
  type MainSessionRecoveryCommand,
  type MainSessionRecoveryOwnerClaim,
  type MainSessionRecoveryReservation,
  type MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-state.js";

export type MainSessionRecoveryStoreTarget = {
  agentId?: string;
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
  stateDir?: string;
};

function matchesReservation(entry: SessionEntry, reservation: MainSessionRecoveryReservation) {
  const state = entry.mainRestartRecovery;
  return (
    entry.sessionId === reservation.sessionId &&
    state?.cycleId === reservation.cycleId &&
    state.reservation?.runId === reservation.runId &&
    state.reservation.lifecycleGeneration === reservation.lifecycleGeneration
  );
}

function currentGenerationRequiredBy(command: MainSessionRecoveryCommand): string | undefined {
  // Generation gates new decisions. Exact reservation/token cleanup must remain
  // valid after a restart so the old owner cannot leak its slot or claim.
  if (command.kind === "validate_foreground" || command.kind === "bind_foreground_run") {
    return command.claim.lifecycleGeneration;
  }
  return "lifecycleGeneration" in command ? command.lifecycleGeneration : undefined;
}

export async function commitMainSessionRecovery(params: {
  command: MainSessionRecoveryCommand;
  expectedSessionId?: string;
  requireWriteSuccess?: boolean;
  scanAliases?: boolean;
  shouldContinue?: () => boolean;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryStoreResult> {
  const reservationCleanup =
    params.command.kind === "cancel_reservation" || params.command.kind === "abandon_reservation"
      ? params.command.reservation
      : undefined;
  const recoveryAdmission =
    params.command.kind === "admit_recovery" || params.command.kind === "validate_recovery"
      ? params.command
      : undefined;
  const ownerClaim = params.command.kind === "claim_foreground" ? params.command : undefined;
  const exactOwnerClaim =
    params.command.kind === "validate_foreground" || params.command.kind === "release_foreground"
      ? params.command.claim
      : undefined;
  const result = await applySessionEntryReplacements<MainSessionRecoveryStoreResult | undefined>({
    agentId: params.target.agentId,
    requireWriteSuccess: params.requireWriteSuccess,
    ...(params.scanAliases ? {} : { sessionKeys: [params.target.sessionKey] }),
    storePath: params.target.storePath,
    update: (entries) => {
      // Recheck after entering write admission: shutdown can begin while this
      // recovery owner is waiting, including between exact and moved-key lookups.
      const expectedGeneration = currentGenerationRequiredBy(params.command);
      if (
        params.shouldContinue?.() === false ||
        (expectedGeneration && expectedGeneration !== getAgentEventLifecycleGeneration())
      ) {
        return {
          result: {
            transition: { kind: "rejected", reason: "stale_generation" },
          },
        };
      }
      const selected = entries.find(({ sessionKey }) => sessionKey === params.target.sessionKey);
      let candidate =
        (params.expectedSessionId && selected?.entry.sessionId !== params.expectedSessionId) ||
        (ownerClaim && selected?.entry.sessionId !== ownerClaim.sessionId)
          ? undefined
          : selected;
      if (reservationCleanup) {
        candidate = entries.find(({ entry }) => matchesReservation(entry, reservationCleanup));
      } else if (recoveryAdmission) {
        // Canonical session-key migration may happen between reservation and
        // Gateway admission; the reservation identity remains authoritative.
        candidate = entries.find(({ entry }) => {
          const reservation = (entry as SessionEntry).mainRestartRecovery?.reservation;
          return (
            entry.sessionId === recoveryAdmission.sessionId &&
            reservation?.runId === recoveryAdmission.runId &&
            reservation.lifecycleGeneration === recoveryAdmission.lifecycleGeneration
          );
        });
      } else if (exactOwnerClaim) {
        candidate = entries.find(({ entry }) => {
          const state = (entry as SessionEntry).mainRestartRecovery;
          return (
            state?.cycleId === exactOwnerClaim.cycleId &&
            state.foregroundClaims?.lifecycleGeneration === exactOwnerClaim.lifecycleGeneration &&
            state.foregroundClaims.tokens.includes(exactOwnerClaim.claimId)
          );
        });
      } else if (ownerClaim && (!selected || selected.entry.sessionId !== ownerClaim.sessionId)) {
        candidate = entries.find(({ entry }) => entry.sessionId === ownerClaim.sessionId);
      } else if (params.scanAliases && params.expectedSessionId) {
        candidate = entries.find(({ entry }) => entry.sessionId === params.expectedSessionId);
      }
      if (
        !candidate &&
        !params.scanAliases &&
        (reservationCleanup ||
          recoveryAdmission ||
          exactOwnerClaim ||
          ownerClaim ||
          params.command.kind === "inspect")
      ) {
        // Discover moved identities only after the exact key misses.
        return { result: undefined };
      }
      if (reservationCleanup || recoveryAdmission || exactOwnerClaim) {
        candidate ??= selected;
      }
      if (!candidate) {
        return {
          result: {
            entry: selected?.entry,
            sessionKey: selected?.sessionKey,
            transition: { kind: "rejected", reason: "session_replaced" },
          },
        };
      }
      const entry = candidate.entry as SessionEntry;
      const previousRecoveryState = entry.mainRestartRecovery;
      const command =
        (params.command.kind === "claim_foreground" ||
          params.command.kind === "observe" ||
          params.command.kind === "inspect") &&
        params.command.sessionKey !== candidate.sessionKey
          ? { ...params.command, sessionKey: candidate.sessionKey }
          : params.command;
      const transition = transitionMainSessionRecovery(entry, command);
      const changed =
        previousRecoveryState !== entry.mainRestartRecovery ||
        (transition.kind !== "foreground_validated" &&
          transition.kind !== "no_change" &&
          transition.kind !== "observed" &&
          transition.kind !== "rejected");
      return {
        result: { entry, sessionKey: candidate.sessionKey, transition },
        ...(changed ? { replacements: [{ sessionKey: candidate.sessionKey, entry }] } : {}),
      };
    },
  });
  return result ?? commitMainSessionRecovery({ ...params, scanAliases: true });
}

export async function refreshMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease,
  runId?: string,
): Promise<
  { lease: MainSessionRecoveryOwnerLease; entry: SessionEntry; sessionKey: string } | undefined
> {
  const result = await commitMainSessionRecovery({
    command: runId
      ? { kind: "bind_foreground_run", claim: lease, runId }
      : { kind: "validate_foreground", claim: lease },
    requireWriteSuccess: true,
    target: lease,
  });
  const accepted = runId
    ? result.transition.kind === "applied"
    : result.transition.kind === "foreground_validated";
  return accepted && result.entry && result.sessionKey
    ? {
        lease: runId ? { ...lease, runId } : lease,
        entry: result.entry,
        sessionKey: result.sessionKey,
      }
    : undefined;
}

export async function claimMainSessionRecoveryOwner(params: {
  allowMissingSession?: boolean;
  lifecycleGeneration: string;
  replacementSessionId?: string;
  sessionId: string;
  runId?: string;
  target: MainSessionRecoveryStoreTarget;
}) {
  const claim = await commitMainSessionRecovery({
    command: {
      kind: "claim_foreground",
      cycleId: randomUUID(),
      lifecycleGeneration: params.lifecycleGeneration,
      sessionId: params.sessionId,
      sessionKey: params.target.sessionKey,
      claimId: randomUUID(),
      ...(params.runId ? { runId: params.runId } : {}),
    },
    requireWriteSuccess: true,
    target: params.target,
  });
  if (claim.transition.kind === "foreground_claimed") {
    if (!claim.entry || !claim.sessionKey) {
      return { kind: "invalidated", reason: "state_changed" } as const;
    }
    return {
      kind: "claimed",
      lease: { ...params.target, ...claim.transition.claim },
      entry: claim.entry,
      sessionKey: claim.sessionKey,
    } as const;
  }
  if (claim.transition.kind === "rejected" && claim.transition.reason === "stale_generation") {
    return { kind: "invalidated", reason: claim.transition.reason } as const;
  }
  if (!claim.entry && (params.allowMissingSession || params.replacementSessionId)) {
    // A fresh explicit session has no predecessor. An automatic rollover can
    // also lose its predecessor before admission. Either way, no row remains to fence.
    return { kind: "not_required" } as const;
  }
  const healthyExpectedSession =
    claim.entry &&
    claim.entry.abortedLastRun !== true &&
    claim.entry.restartRecoveryRuns === undefined &&
    claim.entry.mainRestartRecovery === undefined &&
    (claim.entry.sessionId === params.sessionId ||
      claim.entry.sessionId === params.replacementSessionId);
  if (
    claim.entry?.sessionId === params.sessionId &&
    claim.sessionKey &&
    !isMainRestartRecoveryCandidate(claim.entry, claim.sessionKey)
  ) {
    return { kind: "not_required" } as const;
  }
  if (healthyExpectedSession) {
    // A healthy completion may clear recovery between the caller's read and this
    // transaction. Only that fully clean same-session state can proceed unclaimed.
    return { kind: "not_required" } as const;
  }
  const reason = claim.transition.kind === "rejected" ? claim.transition.reason : "state_changed";
  return { kind: "invalidated", reason } as const;
}

export async function inspectMainSessionRecoveryRequired(params: {
  allowMissingSession?: boolean;
  expectedSessionId: string;
  lifecycleGeneration: string;
  target: MainSessionRecoveryStoreTarget;
}) {
  const result = await commitMainSessionRecovery({
    command: {
      kind: "inspect",
      lifecycleGeneration: params.lifecycleGeneration,
      sessionKey: params.target.sessionKey,
    },
    expectedSessionId: params.expectedSessionId,
    requireWriteSuccess: true,
    target: params.target,
  });
  if (result.transition.kind === "observed") {
    return result.transition.view.status === "inactive"
      ? { kind: "not_required" }
      : { kind: "required" };
  }
  if (result.transition.kind === "rejected" && result.transition.reason === "session_replaced") {
    return !result.entry && params.allowMissingSession
      ? { kind: "not_required" }
      : { kind: "invalidated", reason: result.transition.reason };
  }
  return {
    kind: "invalidated",
    reason: result.transition.kind === "rejected" ? result.transition.reason : "state_changed",
  };
}

async function releaseMainSessionRecoveryOwnerWithRetries(
  lease: MainSessionRecoveryOwnerLease,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  // A leaked current-generation token blocks automatic recovery until restart.
  // Token-scoped release is idempotent, so transient writer failures are safe to retry.
  const released = await retryMainSessionRecoveryMutation(async () =>
    commitMainSessionRecovery({
      command: { kind: "release_foreground", claim: lease },
      requireWriteSuccess: true,
      target: lease,
    }),
  );
  const { entry, sessionKey } = released;
  if (
    (released.transition.kind !== "applied" && released.transition.kind !== "no_change") ||
    !entry ||
    !sessionKey ||
    entry.sessionId !== lease.sessionId ||
    !isMainSessionRecoveryPending(entry, sessionKey)
  ) {
    return undefined;
  }
  return {
    agentId: lease.agentId,
    sessionId: entry.sessionId,
    sessionKey,
    storePath: lease.storePath,
  };
}

export async function releaseMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease | undefined,
): Promise<MainSessionRecoveryPendingTarget | undefined> {
  if (!lease) {
    return undefined;
  }
  try {
    return await releaseMainSessionRecoveryOwnerWithRetries(lease);
  } catch (error) {
    // Exact-token cleanup survives transient writer outages without blocking its caller.
    scheduleMainSessionRecoveryMutation({
      mutation: () => releaseMainSessionRecoveryOwnerWithRetries(lease),
      onSuccess: async (pending) => {
        if (pending) {
          const { scheduleMainSessionRecoveryPendingTarget } =
            await import("./main-session-recovery-owner-release.js");
          scheduleMainSessionRecoveryPendingTarget(pending);
        }
      },
    });
    throw error;
  }
}
