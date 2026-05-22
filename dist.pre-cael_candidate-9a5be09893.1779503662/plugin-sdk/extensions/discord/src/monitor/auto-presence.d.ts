import { type AuthProfileFailureReason, type AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { UpdatePresenceData } from "../internal/gateway.js";
type DiscordAutoPresenceState = "healthy" | "degraded" | "exhausted";
type DiscordAutoPresenceDecision = {
    state: DiscordAutoPresenceState;
    unavailableReason?: AuthProfileFailureReason | null;
    presence: UpdatePresenceData;
};
type PresenceGateway = {
    isConnected: boolean;
    updatePresence: (payload: UpdatePresenceData) => void;
};
export declare function resolveDiscordAutoPresenceDecision(params: {
    discordConfig: Pick<DiscordAccountConfig, "autoPresence" | "activity" | "status" | "activityType" | "activityUrl">;
    authStore: AuthProfileStore;
    gatewayConnected: boolean;
    now?: number;
}): DiscordAutoPresenceDecision | null;
type DiscordAutoPresenceController = {
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
export {};
