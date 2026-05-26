import type { SessionConfig, SessionResetConfig } from "../types.base.js";
export type SessionResetMode = "daily" | "idle";
export type SessionResetType = "direct" | "group" | "thread";
export type SessionResetPolicy = {
    mode: SessionResetMode;
    atHour: number;
    idleMinutes?: number;
    configured?: boolean;
};
export type SessionFreshness = {
    fresh: boolean;
    dailyResetAt?: number;
    idleExpiresAt?: number;
};
export declare const DEFAULT_RESET_MODE: SessionResetMode;
export declare const DEFAULT_RESET_AT_HOUR = 4;
export declare function resolveDailyResetAtMs(now: number, atHour: number): number;
export declare function resolveSessionResetPolicy(params: {
    sessionCfg?: SessionConfig;
    resetType: SessionResetType;
    resetOverride?: SessionResetConfig;
}): SessionResetPolicy;
export declare function evaluateSessionFreshness(params: {
    updatedAt: number;
    sessionStartedAt?: number;
    lastInteractionAt?: number;
    now: number;
    policy: SessionResetPolicy;
}): SessionFreshness;
