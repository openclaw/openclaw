import type { OpenKeyedStoreOptions, PluginStateKeyedStore } from "./plugin-state-store.types.js";
export type { OpenKeyedStoreOptions, PluginStateEntry, PluginStateKeyedStore, PluginStateStoreErrorCode, PluginStateStoreOperation, PluginStateStoreProbeResult, PluginStateStoreProbeStep, } from "./plugin-state-store.types.js";
export { PluginStateStoreError } from "./plugin-state-store.types.js";
export { closePluginStateSqliteStore, isPluginStateDatabaseOpen, probePluginStateStore, sweepExpiredPluginStateEntries, } from "./plugin-state-store.sqlite.js";
export declare function createPluginStateKeyedStore<T>(pluginId: string, options: OpenKeyedStoreOptions): PluginStateKeyedStore<T>;
export declare function createCorePluginStateKeyedStore<T>(options: OpenKeyedStoreOptions & {
    ownerId: `core:${string}`;
}): PluginStateKeyedStore<T>;
export declare function resetPluginStateStoreForTests(): void;
