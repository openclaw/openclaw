import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ThreadBindingLifecycleRecord } from "../shared/thread-binding-lifecycle.js";
export { resolveThreadBindingLifecycle, type ThreadBindingLifecycleRecord, } from "../shared/thread-binding-lifecycle.js";
export type ThreadBindingSpawnKind = "subagent" | "acp";
export type ThreadBindingSpawnPolicy = {
    channel: string;
    accountId: string;
    enabled: boolean;
    spawnEnabled: boolean;
    defaultSpawnContext: ThreadBindingSpawnContext;
};
export type ThreadBindingSpawnContext = "isolated" | "fork";
export declare function supportsAutomaticThreadBindingSpawn(channel: string): boolean;
export declare function requiresNativeThreadContextForThreadHere(channel: string): boolean;
export declare function resolveThreadBindingPlacementForCurrentContext(params: {
    channel: string;
    threadId?: string;
}): "current" | "child";
export declare function resolveThreadBindingIdleTimeoutMs(params: {
    channelIdleHoursRaw: unknown;
    sessionIdleHoursRaw: unknown;
}): number;
export declare function resolveThreadBindingMaxAgeMs(params: {
    channelMaxAgeHoursRaw: unknown;
    sessionMaxAgeHoursRaw: unknown;
}): number;
export declare function resolveThreadBindingEffectiveExpiresAt(params: {
    record: ThreadBindingLifecycleRecord;
    defaultIdleTimeoutMs: number;
    defaultMaxAgeMs: number;
}): number | undefined;
export declare function resolveThreadBindingsEnabled(params: {
    channelEnabledRaw: unknown;
    sessionEnabledRaw: unknown;
}): boolean;
export declare function resolveThreadBindingSpawnPolicy(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string;
    kind: ThreadBindingSpawnKind;
}): ThreadBindingSpawnPolicy;
export declare function resolveThreadBindingIdleTimeoutMsForChannel(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string;
}): number;
export declare function resolveThreadBindingMaxAgeMsForChannel(params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string;
}): number;
export declare function formatThreadBindingDisabledError(params: {
    channel: string;
    accountId: string;
    kind: ThreadBindingSpawnKind;
}): string;
export declare function formatThreadBindingSpawnDisabledError(params: {
    channel: string;
    accountId: string;
    kind: ThreadBindingSpawnKind;
}): string;
