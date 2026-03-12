import type { OpenClawConfig } from "../../config/config.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";
export declare function resolveProfileUnusableUntil(stats: Pick<ProfileUsageStats, "cooldownUntil" | "disabledUntil">): number | null;
/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 */
export declare function isProfileInCooldown(store: AuthProfileStore, profileId: string): boolean;
/**
 * Infer the most likely reason all candidate profiles are currently unavailable.
 *
 * We prefer explicit active `disabledReason` values (for example billing/auth)
 * over generic cooldown buckets, then fall back to failure-count signals.
 */
export declare function resolveProfilesUnavailableReason(params: {
    store: AuthProfileStore;
    profileIds: string[];
    now?: number;
}): AuthProfileFailureReason | null;
/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export declare function getSoonestCooldownExpiry(store: AuthProfileStore, profileIds: string[]): number | null;
/**
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start
 * (circuit-breaker half-open → closed). Without this, a stale `errorCount`
 * causes the *next* transient failure to immediately escalate to a much longer
 * cooldown — the root cause of profiles appearing "stuck" after rate limits.
 *
 * `cooldownUntil` and `disabledUntil` are handled independently: if a profile
 * has both and only one has expired, only that field is cleared.
 *
 * Mutates the in-memory store; disk persistence happens lazily on the next
 * store write (e.g. `markAuthProfileUsed` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
export declare function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean;
/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export declare function markAuthProfileUsed(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
}): Promise<void>;
export declare function calculateAuthProfileCooldownMs(errorCount: number): number;
export declare function resolveProfileUnusableUntilForDisplay(store: AuthProfileStore, profileId: string): number | null;
/**
 * Mark a profile as failed for a specific reason. Billing and permanent-auth
 * failures are treated as "disabled" (longer backoff) vs the regular cooldown
 * window.
 */
export declare function markAuthProfileFailure(params: {
    store: AuthProfileStore;
    profileId: string;
    reason: AuthProfileFailureReason;
    cfg?: OpenClawConfig;
    agentDir?: string;
}): Promise<void>;
/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export declare function markAuthProfileCooldown(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
}): Promise<void>;
/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export declare function clearAuthProfileCooldown(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
}): Promise<void>;
