import type { SessionConfig, SessionResetConfig } from "../types.base.js";
export type SessionResetMode = "daily" | "idle";
export type SessionResetType = "direct" | "group" | "thread";
export type SessionResetPolicy = {
    mode: SessionResetMode;
    atHour: number;
    idleMinutes?: number;
};
export type SessionFreshness = {
    fresh: boolean;
    dailyResetAt?: number;
    idleExpiresAt?: number;
};
export declare const DEFAULT_RESET_MODE: SessionResetMode;
export declare const DEFAULT_RESET_AT_HOUR = 4;
export declare function isThreadSessionKey(sessionKey?: string | null): boolean;
export declare function resolveSessionResetType(params: {
    sessionKey?: string | null;
    isGroup?: boolean;
    isThread?: boolean;
}): SessionResetType;
export declare function resolveThreadFlag(params: {
    sessionKey?: string | null;
    messageThreadId?: string | number | null;
    threadLabel?: string | null;
    threadStarterBody?: string | null;
    parentSessionKey?: string | null;
}): boolean;
export declare function resolveDailyResetAtMs(now: number, atHour: number): number;
export declare function resolveSessionResetPolicy(params: {
    sessionCfg?: SessionConfig;
    resetType: SessionResetType;
    resetOverride?: SessionResetConfig;
}): SessionResetPolicy;
export declare function resolveChannelResetConfig(params: {
    sessionCfg?: SessionConfig;
    channel?: string | null;
}): SessionResetConfig | undefined;
export declare function evaluateSessionFreshness(params: {
    updatedAt: number;
    now: number;
    policy: SessionResetPolicy;
}): SessionFreshness;
