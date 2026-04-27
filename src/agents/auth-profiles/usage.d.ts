import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "./types.js";
export { clearExpiredCooldowns, getSoonestCooldownExpiry, isProfileInCooldown, resolveProfileUnusableUntil, } from "./usage-state.js";
export declare const __testing: {
    setDepsForTest(overrides: Partial<{
        saveAuthProfileStore: typeof saveAuthProfileStore;
        updateAuthProfileStoreWithLock: typeof updateAuthProfileStoreWithLock;
    }> | null): void;
};
type WhamCooldownProbeResult = {
    cooldownMs: number;
    reason: string;
};
export declare function probeWhamForCooldown(store: AuthProfileStore, profileId: string): Promise<WhamCooldownProbeResult | null>;
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
    runId?: string;
    modelId?: string;
}): Promise<void>;
/**
 * Mark a profile as transiently failed. Applies stepped backoff cooldown.
 * Cooldown times: 30s, 1min, 5min (capped).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export declare function markAuthProfileCooldown(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
    runId?: string;
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
