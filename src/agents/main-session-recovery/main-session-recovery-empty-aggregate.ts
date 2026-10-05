import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";

export function getMainSessionRecoveryRetryCount(
  state: SessionEntry["mainRestartRecovery"],
): number {
  return state ? state.chargedAttempts - (state.startedAttempt ?? 0) : 0;
}

/** A reader may resume only the provider-wait disposition it understands. */
export function hasOpaqueProviderCapacityWait(
  entry: Pick<SessionEntry, "mainRestartRecovery">,
): boolean {
  const provider: unknown = entry.mainRestartRecovery?.capacityWait?.provider;
  return (
    provider !== undefined &&
    (entry.mainRestartRecovery?.capacityWait?.worker !== undefined ||
      !isRecord(provider) ||
      provider.kind !== "settled-shortage-v1" ||
      ![
        provider.environmentId,
        provider.operationId,
        provider.leaseId,
        provider.attemptName,
        provider.attemptNonce,
        provider.providerId,
        provider.profileId,
        provider.providerCode,
      ].every((value) => typeof value === "string" && value.length > 0) ||
      typeof provider.ownerEpoch !== "number" ||
      !Number.isSafeInteger(provider.ownerEpoch) ||
      provider.ownerEpoch < 0 ||
      ![provider.placementGeneration, provider.attempt].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0,
      ) ||
      (provider.refunded !== undefined && provider.refunded !== true))
  );
}

export function isMainRestartRecoveryAggregateEmptyAndUnowned(entry: SessionEntry): boolean {
  const state = entry.mainRestartRecovery;
  return (
    entry.abortedLastRun !== true &&
    state !== undefined &&
    state.chargedAttempts === 0 &&
    state.startedAttempt === undefined &&
    state.goalIntent === undefined &&
    state.turnIntent === undefined &&
    state.queuedInputsPending !== true &&
    state.capacityWait === undefined &&
    state.pause === undefined &&
    state.executionIdentity === undefined &&
    state.reservation === undefined &&
    state.foregroundClaims === undefined &&
    state.tombstone === undefined &&
    entry.restartRecoveryRuns === undefined &&
    entry.restartRecoveryDeliveryRunId === undefined &&
    entry.pendingFinalDelivery === undefined
  );
}
