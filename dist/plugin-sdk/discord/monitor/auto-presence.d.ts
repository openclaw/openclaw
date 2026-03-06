import type { UpdatePresenceData } from "@buape/carbon/gateway";
import { type AuthProfileFailureReason, type AuthProfileStore } from "../../agents/auth-profiles.js";
import type { DiscordAccountConfig, DiscordAutoPresenceConfig } from "../../config/config.js";
export type DiscordAutoPresenceState = "healthy" | "degraded" | "exhausted";
type ResolvedDiscordAutoPresenceConfig = {
    enabled: boolean;
    intervalMs: number;
    minUpdateIntervalMs: number;
    healthyText?: string;
    degradedText?: string;
    exhaustedText?: string;
};
export type DiscordAutoPresenceDecision = {
    state: DiscordAutoPresenceState;
    unavailableReason?: AuthProfileFailureReason | null;
    presence: UpdatePresenceData;
};
type PresenceGateway = {
    isConnected: boolean;
    updatePresence: (payload: UpdatePresenceData) => void;
};
declare function resolveAutoPresenceConfig(config?: DiscordAutoPresenceConfig): ResolvedDiscordAutoPresenceConfig;
declare function resolveAuthAvailability(params: {
    store: AuthProfileStore;
    now: number;
}): {
    state: DiscordAutoPresenceState;
    unavailableReason?: AuthProfileFailureReason | null;
};
export declare function resolveDiscordAutoPresenceDecision(params: {
    discordConfig: Pick<DiscordAccountConfig, "autoPresence" | "activity" | "status" | "activityType" | "activityUrl">;
    authStore: AuthProfileStore;
    gatewayConnected: boolean;
    now?: number;
}): DiscordAutoPresenceDecision | null;
declare function stablePresenceSignature(payload: UpdatePresenceData): string;
export type DiscordAutoPresenceController = {
    start: () => void;
    stop: () => void;
    refresh: () => void;
    runNow: () => void;
    enabled: boolean;
};
export declare function createDiscordAutoPresenceController(params: {
    accountId: string;
    discordConfig: Pick<DiscordAccountConfig, "autoPresence" | "activity" | "status" | "activityType" | "activityUrl">;
    gateway: PresenceGateway;
    loadAuthStore?: () => AuthProfileStore;
    now?: () => number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    log?: (message: string) => void;
}): DiscordAutoPresenceController;
export declare const __testing: {
    resolveAutoPresenceConfig: typeof resolveAutoPresenceConfig;
    resolveAuthAvailability: typeof resolveAuthAvailability;
    stablePresenceSignature: typeof stablePresenceSignature;
};
export {};
