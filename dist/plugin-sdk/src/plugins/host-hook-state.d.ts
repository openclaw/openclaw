import { type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export { clearPluginOwnedSessionState } from "./host-hook-cleanup.js";
import { type PluginAgentTurnPrepareResult, type PluginJsonValue, type PluginNextTurnInjection, type PluginNextTurnInjectionEnqueueResult, type PluginNextTurnInjectionRecord, type PluginSessionExtensionProjection } from "./host-hooks.js";
export declare function enqueuePluginNextTurnInjection(params: {
    cfg: OpenClawConfig;
    pluginId: string;
    pluginName?: string;
    injection: PluginNextTurnInjection;
    now?: number;
}): Promise<PluginNextTurnInjectionEnqueueResult>;
export declare function drainPluginNextTurnInjections(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    now?: number;
}): Promise<PluginNextTurnInjectionRecord[]>;
export declare function drainPluginNextTurnInjectionContext(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    now?: number;
}): Promise<PluginAgentTurnPrepareResult & {
    queuedInjections: PluginNextTurnInjectionRecord[];
}>;
export declare function getPluginSessionExtensionSync<T extends PluginJsonValue = PluginJsonValue>(params: {
    cfg: OpenClawConfig;
    pluginId: string;
    sessionKey?: string;
    namespace: string;
}): T | undefined;
export declare function getPluginSessionExtensionStateSync(params: {
    cfg: OpenClawConfig;
    pluginId: string;
    sessionKey?: string;
}): Record<string, PluginJsonValue> | undefined;
export declare function patchPluginSessionExtension(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    pluginId: string;
    namespace: string;
    value?: PluginJsonValue;
    unset?: boolean;
}): Promise<{
    ok: true;
    key: string;
    value?: PluginJsonValue;
} | {
    ok: false;
    error: string;
}>;
export declare function projectPluginSessionExtensions(params: {
    sessionKey: string;
    entry: SessionEntry;
}): Promise<PluginSessionExtensionProjection[]>;
export declare function projectPluginSessionExtensionsSync(params: {
    sessionKey: string;
    entry: SessionEntry;
}): PluginSessionExtensionProjection[];
