import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
export declare function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean;
export declare function resolveProfileUnusableUntil(stats: Pick<ProfileUsageStats, "cooldownUntil" | "disabledUntil">): number | null;
export declare function isActiveUnusableWindow(until: number | undefined, now: number): boolean;
/**
 * Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
 */
export declare function isProfileInCooldown(store: AuthProfileStore, profileId: string, now?: number, forModel?: string): boolean;
/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export declare function getSoonestCooldownExpiry(store: AuthProfileStore, profileIds: string[], options?: {
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
 * store write (e.g. `markAuthProfileUsed` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
export declare function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean;
