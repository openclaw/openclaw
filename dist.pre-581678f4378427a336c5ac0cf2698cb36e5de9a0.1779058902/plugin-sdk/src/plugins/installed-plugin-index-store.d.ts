import { type InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
import { type InstalledPluginIndex, type InstalledPluginIndexRefreshReason, type LoadInstalledPluginIndexParams, type RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
export { resolveInstalledPluginIndexStorePath, type InstalledPluginIndexStoreOptions, } from "./installed-plugin-index-store-path.js";
export type InstalledPluginIndexStoreState = "missing" | "fresh" | "stale";
export type InstalledPluginIndexStoreInspection = {
    state: InstalledPluginIndexStoreState;
    refreshReasons: readonly InstalledPluginIndexRefreshReason[];
    persisted: InstalledPluginIndex | null;
    current: InstalledPluginIndex;
};
export declare function readPersistedInstalledPluginIndex(options?: InstalledPluginIndexStoreOptions): Promise<InstalledPluginIndex | null>;
export declare function readPersistedInstalledPluginIndexSync(options?: InstalledPluginIndexStoreOptions): InstalledPluginIndex | null;
export declare function writePersistedInstalledPluginIndex(index: InstalledPluginIndex, options?: InstalledPluginIndexStoreOptions): Promise<string>;
export declare function writePersistedInstalledPluginIndexSync(index: InstalledPluginIndex, options?: InstalledPluginIndexStoreOptions): string;
export declare function inspectPersistedInstalledPluginIndex(params?: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): Promise<InstalledPluginIndexStoreInspection>;
export declare function refreshPersistedInstalledPluginIndex(params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): Promise<InstalledPluginIndex>;
export declare function refreshPersistedInstalledPluginIndexSync(params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): InstalledPluginIndex;
