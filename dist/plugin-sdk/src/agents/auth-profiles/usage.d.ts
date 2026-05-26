import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileBlockedSource, AuthProfileFailureReason, AuthProfileStore } from "./types.js";
export { clearExpiredCooldowns, getSoonestCooldownExpiry, isProfileInCooldown, resolveProfileUnusableUntil, } from "./usage-state.js";
export declare function setAuthProfileFailureHook(hook: (() => void) | undefined): void;
export declare const testing: {
    setDepsForTest(overrides: Partial<{
        saveAuthProfileStore: typeof saveAuthProfileStore;
        updateAuthProfileStoreWithLock: typeof updateAuthProfileStoreWithLock;
    }> | null): void;
};
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
export declare function markAuthProfileBlockedUntil(params: {
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
export { testing as __testing };
