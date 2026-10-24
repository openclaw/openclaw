import { randomUUID } from "node:crypto";
import {
  buildRestartRecoveryClaimCleanupPatch,
  mergeRestartRecoveryTerminalRunIds,
} from "../../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";

function ownedRunIds(entry: InternalSessionEntry): Set<string> {
  const owned = new Set<string>();
  for (const owner of entry.durableQuestionOwners ?? []) {
    if (
      owner.sessionId === entry.sessionId &&
      owner.lifecycleRevision === entry.lifecycleRevision
    ) {
      owned.add(owner.sourceRunId);
      if (owner.continuationRunId) {
        owned.add(owner.continuationRunId);
      }
    }
  }
  return owned;
}

/** Native question custody outlives its presentation receipt and transcript retention. */
export function isDurableQuestionRecoveryOwned(entry: InternalSessionEntry): boolean {
  const owned = ownedRunIds(entry);
  return [
    entry.lifecycleRunId,
    entry.restartRecoveryDeliveryRunId,
    entry.restartRecoveryDeliverySourceRunId,
    entry.mainRestartRecovery?.reservation?.runId,
    ...Object.values(entry.mainRestartRecovery?.foregroundClaims?.runIdsByClaimId ?? {}),
    ...(entry.restartRecoveryRuns ?? []).map((run) => run.runId),
  ].some((runId) => runId !== undefined && owned.has(runId));
}

export function isDurableQuestionCurrentSource(entry: InternalSessionEntry): boolean {
  const owned = ownedRunIds(entry);
  const explicit = [
    entry.restartRecoveryDeliveryRunId,
    entry.restartRecoveryDeliverySourceRunId,
  ].filter((runId): runId is string => runId !== undefined);
  if (explicit.length) {
    return explicit.some((runId) => owned.has(runId));
  }
  if (entry.lifecycleRunId) {
    return owned.has(entry.lifecycleRunId);
  }
  // Cohort IDs without independent ingress provenance cannot authorize a replay
  // of the whole conversation after a question acquired durable custody.
  return (entry.restartRecoveryRuns ?? []).some((run) => owned.has(run.runId));
}

/** Consume only exact question fences; a mixed conversation has no independent replay source. */
export function buildDurableQuestionRecoverySettlementPatch(
  entry: InternalSessionEntry,
  options?: { completedFinal?: boolean },
): Partial<InternalSessionEntry> {
  const owned = ownedRunIds(entry);
  const currentSourceOwned = isDurableQuestionCurrentSource(entry);
  const remaining = (entry.restartRecoveryRuns ?? []).filter((run) => !owned.has(run.runId));
  const state = entry.mainRestartRecovery;
  const foreground = state?.foregroundClaims;
  const tokens = foreground?.tokens.filter((token) => {
    const runId = foreground.runIdsByClaimId?.[token];
    return !runId || !owned.has(runId);
  });
  const remainingForeground =
    foreground && tokens?.length
      ? {
          ...foreground,
          tokens,
          runIdsByClaimId: Object.fromEntries(
            Object.entries(foreground.runIdsByClaimId ?? {}).filter(([token]) =>
              tokens.includes(token),
            ),
          ),
        }
      : undefined;
  const reservation =
    state?.reservation && !owned.has(state.reservation.runId) ? state.reservation : undefined;
  const finalRetained = Boolean(entry.pendingFinalDelivery && !options?.completedFinal);
  const otherOwnership = Boolean(remaining.length || reservation || remainingForeground);
  const failClosed = currentSourceOwned && (otherOwnership || finalRetained);
  const endedAt = Date.now();
  return {
    ...(currentSourceOwned && !finalRetained
      ? buildRestartRecoveryClaimCleanupPatch({
          entry,
          recordTerminalSource: true,
        })
      : {}),
    restartRecoveryRuns: remaining.length ? remaining : undefined,
    restartRecoveryTerminalRunIds: mergeRestartRecoveryTerminalRunIds(
      entry.restartRecoveryTerminalRunIds,
      [...owned],
    ),
    ...(state || failClosed
      ? {
          mainRestartRecovery:
            !otherOwnership && !finalRetained && currentSourceOwned
              ? undefined
              : {
                  ...(state ?? { cycleId: randomUUID(), chargedAttempts: 0 }),
                  revision: (state?.revision ?? 0) + 1,
                  reservation,
                  foregroundClaims: remainingForeground,
                  ...(failClosed
                    ? {
                        tombstone: {
                          reason:
                            "Question-owned continuation will not automatically replay. Start a new user turn to inspect retained recovery work and final delivery.",
                        },
                      }
                    : {}),
                },
        }
      : {}),
    ...(currentSourceOwned
      ? {
          abortedLastRun: otherOwnership || finalRetained,
          status: options?.completedFinal ? "done" : "interrupted",
          ...(entry.lifecycleRunId && owned.has(entry.lifecycleRunId)
            ? { lifecycleRunId: undefined }
            : {}),
          endedAt,
          updatedAt: endedAt,
          ...(options?.completedFinal ? { pendingFinalDelivery: undefined } : {}),
        }
      : {}),
  };
}
