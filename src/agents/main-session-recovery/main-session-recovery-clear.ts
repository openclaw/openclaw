import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  createMainRestartRecoveryCycle,
  hasMainRestartRecoveryEpisode,
} from "../../config/sessions/main-session-recovery.types.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../../config/sessions/restart-recovery-state.js";

type ForegroundClaims = NonNullable<
  NonNullable<SessionEntry["mainRestartRecovery"]>["foregroundClaims"]
>;

export function removeMainSessionRecoveryForegroundClaim(
  claims: ForegroundClaims,
  claimId: string,
): ForegroundClaims | undefined {
  const tokens = claims.tokens.filter((token) => token !== claimId);
  if (tokens.length === 0) {
    return undefined;
  }
  const runIdsByClaimId = Object.fromEntries(
    Object.entries(claims.runIdsByClaimId ?? {}).filter(([token]) => token !== claimId),
  );
  return {
    lifecycleGeneration: claims.lifecycleGeneration,
    tokens,
    ...(Object.keys(runIdsByClaimId).length > 0 ? { runIdsByClaimId } : {}),
  };
}

type MainRecoveryStateFields = Pick<
  SessionEntry,
  "abortedLastRun" | "restartRecoveryRuns" | "restartRecoveryGoal" | "mainRestartRecovery"
>;

// restartRecoveryDeliveryRunId stays out of this patch: it keys delivery-claim
// adoption (agent-command-restart-recovery.ts), not recovery ownership, and
// clearing it here strands the paired delivery context on the successor entry.
export const MAIN_SESSION_RECOVERY_CLEAR_PATCH: Partial<MainRecoveryStateFields> = {
  abortedLastRun: false,
  restartRecoveryRuns: undefined,
  restartRecoveryGoal: undefined,
  mainRestartRecovery: undefined,
};

export function buildMainSessionRecoveryClearPatch(
  entry?: Partial<
    MainRecoveryStateFields &
      Pick<SessionEntry, "goal" | "goalPauseOrigin" | "sessionId" | "lifecycleRevision">
  > | null,
): Partial<MainRecoveryStateFields> {
  if (entry?.mainRestartRecovery?.pause) {
    return {};
  }
  if (
    entry?.abortedLastRun !== true &&
    entry?.restartRecoveryRuns === undefined &&
    entry?.restartRecoveryGoal === undefined &&
    entry?.mainRestartRecovery === undefined
  ) {
    return {};
  }
  const intent = entry?.mainRestartRecovery?.goalIntent;
  const queued = entry?.mainRestartRecovery?.queuedInputsPending;
  if (
    intent &&
    intent.sessionId === entry?.sessionId &&
    intent.lifecycleRevision === entry.lifecycleRevision &&
    intent.goalId === entry.goal?.id &&
    (entry.goal.status === "active" ||
      entry.goal.status === "budget_limited" ||
      entry.goal.status === "usage_limited" ||
      (entry.goal.status === "paused" && entry.goalPauseOrigin === "terminal-error"))
  ) {
    if (
      !hasMainRestartRecoveryEpisode(entry) &&
      entry.restartRecoveryRuns === undefined &&
      entry.abortedLastRun !== true
    ) {
      return {};
    }
    return {
      ...MAIN_SESSION_RECOVERY_CLEAR_PATCH,
      mainRestartRecovery: {
        ...createMainRestartRecoveryCycle(),
        goalIntent: intent,
        ...(queued ? { queuedInputsPending: true } : {}),
      },
    };
  }
  return queued
    ? {
        ...MAIN_SESSION_RECOVERY_CLEAR_PATCH,
        mainRestartRecovery: { ...createMainRestartRecoveryCycle(), queuedInputsPending: true },
      }
    : MAIN_SESSION_RECOVERY_CLEAR_PATCH;
}

export function buildMainSessionRecoverySettlementPatch(
  params: Parameters<typeof buildRestartRecoveryClaimCleanupPatch>[0] & {
    // A retained delivery snapshot can finish a receipt without owning the current cycle.
    clearRecoveryState?: boolean;
  },
): Partial<SessionEntry> {
  return {
    ...buildRestartRecoveryClaimCleanupPatch(params),
    ...(params.clearRecoveryState === false
      ? {}
      : buildMainSessionRecoveryClearPatch(params.entry)),
  };
}

export function clearMainSessionRecoveryAfterAgentRun(
  entry: SessionEntry,
  clearForceSafeTools: boolean | undefined,
): void {
  if (entry.abortedLastRun === true) {
    return;
  }
  if (clearForceSafeTools) {
    entry.restartRecoveryForceSafeTools = undefined;
  }
  Object.assign(entry, buildMainSessionRecoveryClearPatch(entry));
}

export type { MainRecoveryStateFields };
