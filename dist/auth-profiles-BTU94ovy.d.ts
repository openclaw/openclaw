import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as AuthProfileFailureReason, c as OAuthCredential, i as AuthProfileCredential, r as AuthProfileBlockedSource, s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { r as AuthCredentialReasonCode } from "./repair-BfrBLKET.js";
//#region src/agents/auth-profiles/order.d.ts
type AuthProfileEligibilityReasonCode = AuthCredentialReasonCode | "profile_missing" | "provider_mismatch" | "mode_mismatch";
type AuthProfileEligibility = {
  eligible: boolean;
  reasonCode: AuthProfileEligibilityReasonCode;
};
declare function resolveAuthProfileEligibility(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  now?: number;
}): AuthProfileEligibility;
declare function resolveAuthProfileOrder(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[];
//#endregion
//#region src/agents/auth-profiles/display.d.ts
declare function resolveAuthProfileDisplayLabel(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
}): string;
//#endregion
//#region src/agents/auth-profiles/doctor.d.ts
declare function formatAuthDoctorHint(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
}): Promise<string>;
//#endregion
//#region src/agents/auth-profiles/oauth.d.ts
type ResolveApiKeyForProfileResult = {
  apiKey: string;
  provider: string;
  email?: string;
  profileId: string;
  profileType: AuthProfileCredential["type"];
};
type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  forceRefresh?: boolean;
};
declare function refreshOAuthCredentialForRuntime(params: {
  credential: OAuthCredential;
}): Promise<OAuthCredential | null>;
declare function resolveApiKeyForProfile(params: ResolveApiKeyForProfileParams): Promise<ResolveApiKeyForProfileResult | null>;
//#endregion
//#region src/agents/auth-profiles/usage-state.d.ts
/**
 * Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
 */
declare function isProfileInCooldown(store: AuthProfileStore, profileId: string, now?: number, forModel?: string): boolean;
/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
declare function getSoonestCooldownExpiry(store: AuthProfileStore, profileIds: string[], options?: {
  now?: number;
  forModel?: string;
}): number | null;
/**
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start
 * (circuit-breaker half-open -> closed). Without this, a stale `errorCount`
 * causes the *next* transient failure to immediately escalate to a much longer
 * cooldown -- the root cause of profiles appearing "stuck" after rate limits.
 *
 * `cooldownUntil` and `disabledUntil` are handled independently: if a profile
 * has both and only one has expired, only that field is cleared.
 *
 * Mutates the in-memory store; disk persistence happens lazily on the next
 * store write (e.g. `markAuthProfileSuccess` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
declare function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean;
//#endregion
//#region src/agents/auth-profiles/usage.d.ts
/**
 * Infer the most likely reason all candidate profiles are currently unavailable.
 *
 * We prefer explicit active `disabledReason` values (for example billing/auth)
 * over generic cooldown buckets, then fall back to failure-count signals.
 */
declare function resolveProfilesUnavailableReason(params: {
  store: AuthProfileStore;
  profileIds: string[];
  now?: number;
}): AuthProfileFailureReason | null;
declare function calculateAuthProfileCooldownMs(errorCount: number): number;
declare function resolveProfileUnusableUntilForDisplay(store: AuthProfileStore, profileId: string): number | null;
/**
 * Mark a profile as failed for a specific reason. Billing and permanent-auth
 * failures are treated as "disabled" (longer backoff) vs the regular cooldown
 * window.
 */
declare function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void>;
declare function markAuthProfileBlockedUntil(params: {
  store: AuthProfileStore;
  profileId: string;
  blockedUntil: number;
  source: AuthProfileBlockedSource;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void>;
/**
 * Mark a profile as transiently failed. Applies stepped backoff cooldown.
 * Cooldown times: 30s, 1min, 5min (capped).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
declare function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  runId?: string;
}): Promise<void>;
/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
declare function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void>;
//#endregion
export { resolveAuthProfileOrder as _, markAuthProfileFailure as a, clearExpiredCooldowns as c, refreshOAuthCredentialForRuntime as d, resolveApiKeyForProfile as f, resolveAuthProfileEligibility as g, AuthProfileEligibilityReasonCode as h, markAuthProfileCooldown as i, getSoonestCooldownExpiry as l, resolveAuthProfileDisplayLabel as m, clearAuthProfileCooldown as n, resolveProfileUnusableUntilForDisplay as o, formatAuthDoctorHint as p, markAuthProfileBlockedUntil as r, resolveProfilesUnavailableReason as s, calculateAuthProfileCooldownMs as t, isProfileInCooldown as u };