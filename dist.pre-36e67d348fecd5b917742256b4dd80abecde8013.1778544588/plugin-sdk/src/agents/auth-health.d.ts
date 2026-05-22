import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AuthCredentialReasonCode } from "./auth-profiles/credential-state.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";
type AuthProfileSource = "store";
export type AuthProfileHealthStatus = "ok" | "expiring" | "expired" | "missing" | "static";
type AuthProfileHealth = {
    profileId: string;
    provider: string;
    type: "oauth" | "token" | "api_key";
    status: AuthProfileHealthStatus;
    reasonCode?: AuthCredentialReasonCode;
    expiresAt?: number;
    remainingMs?: number;
    source: AuthProfileSource;
    label: string;
};
export type AuthProviderHealthStatus = "ok" | "expiring" | "expired" | "missing" | "static";
export type AuthProviderHealth = {
    provider: string;
    status: AuthProviderHealthStatus;
    expiresAt?: number;
    remainingMs?: number;
    profiles: AuthProfileHealth[];
};
export type AuthHealthSummary = {
    now: number;
    warnAfterMs: number;
    profiles: AuthProfileHealth[];
    providers: AuthProviderHealth[];
};
export declare const DEFAULT_OAUTH_WARN_MS: number;
export declare function formatRemainingShort(remainingMs?: number, opts?: {
    underMinuteLabel?: string;
}): string;
export declare function buildAuthHealthSummary(params: {
    store: AuthProfileStore;
    cfg?: OpenClawConfig;
    warnAfterMs?: number;
    providers?: string[];
    runtimeCredentialsByProvider?: ReadonlyMap<string, AuthProfileCredential>;
}): AuthHealthSummary;
export {};
