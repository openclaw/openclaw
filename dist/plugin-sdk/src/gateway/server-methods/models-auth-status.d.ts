import { type AuthProfileHealthStatus, type AuthProviderHealth, type AuthProviderHealthStatus } from "../../agents/auth-health.js";
import type { UsageWindow } from "../../infra/provider-usage.types.js";
import type { GatewayRequestHandlers } from "./types.js";
/**
 * Models-auth status wire types. Mirrored in ui/src/ui/types.ts via an
 * `import(...)` re-export — edit here and the UI picks up the change.
 *
 * Expiry fields are grouped into a sub-object so they're present together or
 * not at all: a profile either has a time-bounded credential or it doesn't.
 */
export type ModelAuthExpiry = {
    /** Absolute expiry timestamp, ms since epoch. */
    at: number;
    /** Remaining time in ms (negative if already expired). */
    remainingMs: number;
    /** Human-readable remaining time (e.g. "10d", "2h", "45m"). */
    label: string;
};
export type ModelAuthStatusProfile = {
    profileId: string;
    type: "oauth" | "token" | "api_key";
    status: AuthProfileHealthStatus;
    expiry?: ModelAuthExpiry;
};
export type ModelAuthStatusProvider = {
    provider: string;
    displayName: string;
    status: AuthProviderHealthStatus;
    expiry?: ModelAuthExpiry;
    profiles: ModelAuthStatusProfile[];
    usage?: {
        windows: UsageWindow[];
        plan?: string;
    };
};
export type ModelAuthStatusResult = {
    /** Snapshot build time, ms since epoch. 0 = never loaded (UI fallback sentinel). */
    ts: number;
    providers: ModelAuthStatusProvider[];
};
export type ModelAuthLogoutResult = {
    provider: string;
    removedProfiles: string[];
    abortedRunIds: string[];
};
/**
 * Invalidate the in-memory cache. Reserved for future gateway-side auth
 * mutation handlers (login, logout, token rotation) so the next read returns
 * fresh data. Today those mutations happen via the CLI and the 60s TTL plus
 * `{refresh: true}` param cover the stale-data window.
 */
export declare function invalidateModelAuthStatusCache(): void;
/**
 * Aggregate provider status from OAuth profiles only. `buildAuthHealthSummary`
 * rolls up across both OAuth and token profiles, which mis-reports providers
 * where a healthy OAuth sits alongside an expired/missing bearer token.
 * For the dashboard's OAuth-health signal, token profiles are a separate
 * concern — we want "is OAuth healthy?", not "is every credential healthy?"
 * It also consumes the provider's effective profile subset when auth order
 * excludes stale inventory from the runtime credential path.
 *
 * `expectsOAuth` surfaces the configured-OAuth-but-no-oauth-profile case as
 * `missing` instead of silently falling back to the provider's rollup (which
 * would report `static` if only api_key credentials exist). Without this,
 * switching a provider from api_key to oauth in config but forgetting to
 * login hides behind the residual api_key profile until runtime fails.
 *
 * Exported for direct unit testing of the rollup rules.
 */
export declare function aggregateOAuthStatus(prov: AuthProviderHealth, now?: number, expectsOAuth?: boolean): {
    status: AuthProviderHealthStatus;
    expiresAt?: number;
    remainingMs?: number;
};
export declare const modelsAuthStatusHandlers: GatewayRequestHandlers;
