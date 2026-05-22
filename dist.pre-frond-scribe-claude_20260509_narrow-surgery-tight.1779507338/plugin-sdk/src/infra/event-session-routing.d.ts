import type { SessionScope } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type EventSessionRoutingPolicy = {
    mainKey?: string;
    sessionScope?: SessionScope;
    dmScope?: string | null;
    allowFrom?: ReadonlyArray<string | number> | null;
    channel?: string | null;
    accountId?: string | null;
    preserveSessionKey?: boolean;
};
type DirectSessionTarget = {
    agentId: string;
    channel?: string;
    accountId?: string;
    peerId: string;
};
export declare function parseDirectAgentSessionTarget(sessionKey: string | undefined | null): DirectSessionTarget | null;
export declare function resolveEventSessionAllowFrom(params: {
    cfg?: OpenClawConfig;
    sessionKey?: string | null;
    channel?: string | null;
    accountId?: string | null;
}): Array<string | number> | undefined;
export declare function resolveEventSessionRoutingPolicy(params: {
    cfg?: OpenClawConfig;
    sessionKey?: string | null;
    channel?: string | null;
    accountId?: string | null;
    dmScope?: string | null;
    allowFrom?: ReadonlyArray<string | number> | null;
}): EventSessionRoutingPolicy;
export declare function resolveMainScopedEventSessionKey(params: {
    cfg?: OpenClawConfig;
    sessionKey: string;
    agentId?: string | null;
    policy?: EventSessionRoutingPolicy;
}): string | null;
export declare function resolveEventSessionKeyForPolicy(sessionKey: string, policy?: EventSessionRoutingPolicy): string;
export declare function scopedHeartbeatWakeOptionsForPolicy<T extends object>(sessionKey: string, wakeOptions: T, policy?: EventSessionRoutingPolicy): T | (T & {
    sessionKey: string;
}) | (T & {
    agentId: string;
});
export {};
