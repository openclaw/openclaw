import { type PluginStateEntry, type PluginStateStoreProbeResult } from "./plugin-state-store.types.js";
export declare const MAX_PLUGIN_STATE_VALUE_BYTES = 65536;
export declare const MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN = 1000;
export declare function pluginStateRegister(params: {
    pluginId: string;
    namespace: string;
    key: string;
    valueJson: string;
    maxEntries: number;
    ttlMs?: number;
}): void;
export declare function pluginStateLookup(params: {
    pluginId: string;
    namespace: string;
    key: string;
}): unknown;
export declare function pluginStateConsume(params: {
    pluginId: string;
    namespace: string;
    key: string;
}): unknown;
export declare function pluginStateDelete(params: {
    pluginId: string;
    namespace: string;
    key: string;
}): boolean;
export declare function pluginStateEntries(params: {
    pluginId: string;
    namespace: string;
}): PluginStateEntry<unknown>[];
export declare function pluginStateClear(params: {
    pluginId: string;
    namespace: string;
}): void;
export declare function sweepExpiredPluginStateEntries(): number;
export declare function isPluginStateDatabaseOpen(): boolean;
export declare function probePluginStateStore(): PluginStateStoreProbeResult;
export declare function closePluginStateSqliteStore(): void;
