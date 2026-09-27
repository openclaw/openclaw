import { NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR } from "./native-hook-relay-client.js";
import {
  nativeHookRelayRegistrationsById,
  nativeHookRelayRetiredTurnClaimsById,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayRegistration,
  OwnedNativeHookRelayRegistrationHandle,
  RelayLifetime,
} from "./native-hook-relay-types.js";
import { isJsonObject } from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_RELAY_TURN_CLAIMS = 32;
const MAX_NATIVE_HOOK_RELAY_RETIRED_TURN_CLAIMS = 64;
const { relays } = nativeHookRelayState;

export async function claimAndVerifyRelayTurn(
  handle: Pick<OwnedNativeHookRelayRegistrationHandle, "claimTurn" | "verifyPreToolUse">,
  turnId: string,
  assertCurrent?: () => void,
  bindProcessAuthority?: () => void,
  threadId?: string,
): Promise<void> {
  if (!handle.claimTurn(turnId, threadId)) {
    throw new Error("native hook relay turn claim rejected");
  }
  assertCurrent?.();
  bindProcessAuthority?.();
  assertCurrent?.();
  try {
    await handle.verifyPreToolUse?.(turnId, threadId);
  } catch (error) {
    // Cancellation or replacement that wins during readiness owns the failure.
    // A still-current turn preserves the precise relay component error.
    assertCurrent?.();
    throw error;
  }
  assertCurrent?.();
}

export function normalizeNativeHookRelayKey(
  value: string | undefined,
  kind: "id" | "generation",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error(`native hook relay ${kind} must be non-empty, compact, and URL-safe`);
  }
  return trimmed;
}

export function canAcceptNativeHookRelayGenerationMismatch(
  registration: NativeHookRelayRegistration,
  generation: string,
): boolean {
  const expiresAtMs = registration.generationMismatchGraceExpiresAtMs;
  if (typeof expiresAtMs !== "number" || Date.now() > expiresAtMs) {
    return false;
  }
  if (registration.generationMismatchGraceAcceptedGeneration) {
    return registration.generationMismatchGraceAcceptedGeneration === generation;
  }
  registration.generationMismatchGraceAcceptedGeneration = generation;
  return true;
}

export function latestNativeHookRelayRegistration(
  registrations: Set<ActiveNativeHookRelayRegistration> | undefined,
): ActiveNativeHookRelayRegistration | undefined {
  let latest: ActiveNativeHookRelayRegistration | undefined;
  for (const registration of registrations ?? []) {
    latest = registration;
  }
  return latest;
}

export function isLiveNativeHookRelayRegistration(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): boolean {
  return (
    nativeHookRelayRegistrationsById.get(relayId)?.has(registration) === true ||
    relays.get(relayId) === registration
  );
}

export function ensureNativeHookRelayTurnClaims(
  registration: ActiveNativeHookRelayRegistration,
): Set<string> {
  if (!(registration.claimedTurnIds instanceof Set)) {
    registration.claimedTurnIds = new Set();
  }
  return registration.claimedTurnIds;
}

export function retireNativeHookRelayTurnClaims(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  const claims = ensureNativeHookRelayTurnClaims(registration);
  if (!nativeHookRelayRegistrationsById.get(relayId)?.size) {
    nativeHookRelayRetiredTurnClaimsById.delete(relayId);
    claims.clear();
    return;
  }
  if (claims.size > 0) {
    const retiredClaims = nativeHookRelayRetiredTurnClaimsById.get(relayId) ?? new Set<string>();
    nativeHookRelayRetiredTurnClaimsById.set(relayId, retiredClaims);
    for (const claim of claims) {
      if (retiredClaims.size >= MAX_NATIVE_HOOK_RELAY_RETIRED_TURN_CLAIMS) {
        const oldest = retiredClaims.values().next().value;
        if (oldest) {
          retiredClaims.delete(oldest);
        }
      }
      retiredClaims.add(claim);
    }
  }
  claims.clear();
}

function isRetiredNativeHookRelayTurnClaim(
  relayId: string,
  turnId: string,
  threadId?: string,
): boolean {
  const retiredClaims = nativeHookRelayRetiredTurnClaimsById.get(relayId);
  if (!retiredClaims) {
    return false;
  }
  if (threadId) {
    return retiredClaims.has(buildNativeHookRelayTurnClaimKey(turnId, threadId));
  }
  if (retiredClaims.has(turnId)) {
    return true;
  }
  const scopedSuffix = `\0${turnId}`;
  return [...retiredClaims].some((claim) => claim.endsWith(scopedSuffix));
}

export function buildNativeHookRelayTurnClaimKey(
  turnIdInput: string,
  threadIdInput?: string,
): string {
  const turnId = turnIdInput.trim();
  const threadId = threadIdInput?.trim();
  return threadId ? `${threadId}\0${turnId}` : turnId;
}

export function claimNativeHookRelayTurn(params: {
  relayId: string;
  registration: ActiveNativeHookRelayRegistration;
  turnIdInput: string;
  threadIdInput?: string;
  onDuplicate: (sibling: ActiveNativeHookRelayRegistration) => void;
}): boolean {
  const turnId = params.turnIdInput.trim();
  if (!turnId || !isLiveNativeHookRelayRegistration(params.relayId, params.registration)) {
    return false;
  }
  const claimKey = buildNativeHookRelayTurnClaimKey(turnId, params.threadIdInput);
  if (isRetiredNativeHookRelayTurnClaim(params.relayId, turnId, params.threadIdInput?.trim())) {
    return false;
  }
  const claimedTurnIds = ensureNativeHookRelayTurnClaims(params.registration);
  for (const sibling of nativeHookRelayRegistrationsById.get(params.relayId) ?? []) {
    if (sibling !== params.registration && ensureNativeHookRelayTurnClaims(sibling).has(claimKey)) {
      params.onDuplicate(sibling);
      return false;
    }
  }
  if (claimedTurnIds.size >= MAX_NATIVE_HOOK_RELAY_TURN_CLAIMS && !claimedTurnIds.has(claimKey)) {
    const oldest = claimedTurnIds.values().next().value;
    if (oldest) {
      claimedTurnIds.delete(oldest);
    }
  }
  claimedTurnIds.add(claimKey);
  return true;
}

export function resolveNativeHookRelayInvocationTarget(params: {
  relayId: string;
  requestedGeneration: string | undefined;
  rawPayload: unknown;
  readLifetime: (registration: ActiveNativeHookRelayRegistration) => RelayLifetime | undefined;
}): ActiveNativeHookRelayRegistration | undefined {
  const registrations = nativeHookRelayRegistrationsById.get(params.relayId);
  if (!registrations?.size) {
    return relays.get(params.relayId);
  }

  let childOwner: ActiveNativeHookRelayRegistration | undefined;
  let childOwnerCount = 0;
  for (const candidate of registrations) {
    const retention = params.readLifetime(candidate)?.retention;
    if (!retention) {
      continue;
    }
    try {
      const claim = retention.readClaim(params.rawPayload);
      if (claim && retention.allowPreToolUse(claim)) {
        childOwner = candidate;
        childOwnerCount += 1;
      }
    } catch {
      // A throwing ownership probe grants no routing authority.
    }
  }
  if (childOwnerCount === 1) {
    return childOwner;
  }
  if (childOwnerCount > 1) {
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }

  const turnId =
    isJsonObject(params.rawPayload) && typeof params.rawPayload.turn_id === "string"
      ? params.rawPayload.turn_id.trim()
      : "";
  if (turnId) {
    const threadId =
      isJsonObject(params.rawPayload) && typeof params.rawPayload.session_id === "string"
        ? params.rawPayload.session_id.trim()
        : "";
    const scopedClaimKey = buildNativeHookRelayTurnClaimKey(turnId, threadId);
    if (isRetiredNativeHookRelayTurnClaim(params.relayId, turnId, threadId)) {
      throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
    }
    const scopedOwners = threadId
      ? [...registrations].filter((candidate) =>
          ensureNativeHookRelayTurnClaims(candidate).has(scopedClaimKey),
        )
      : [];
    const owners =
      scopedOwners.length > 0
        ? scopedOwners
        : [...registrations].filter((candidate) =>
            ensureNativeHookRelayTurnClaims(candidate).has(turnId),
          );
    if (owners.length === 1) {
      return owners[0];
    }
    if (registrations.size === 1) {
      const [soleRegistration] = registrations;
      if (soleRegistration && ensureNativeHookRelayTurnClaims(soleRegistration).size === 0) {
        // Preserve the pre-claim public contract for a sole legacy owner. Once an
        // owner participates in exact turn claims, every non-retained turn must
        // resolve through a claim so a released sibling cannot be misrouted here.
        return soleRegistration;
      }
    }
    // Every accepted modern Codex turn is claimed before hooks can execute.
    // Never let a late or unknown turn downgrade to generation/latest routing,
    // including after its original overlapping owner has already exited.
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }

  const generationMatches = params.requestedGeneration
    ? [...registrations].filter((candidate) => candidate.generation === params.requestedGeneration)
    : [];
  if (generationMatches.length === 1) {
    return generationMatches[0];
  }
  if (generationMatches.length > 1) {
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }
  return latestNativeHookRelayRegistration(registrations);
}
