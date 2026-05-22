import type { PluginInstallRecord } from "../config/types.plugins.js";
import { type InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store-path.js";
export declare function readPersistedInstalledPluginIndexInstallRecords(options?: InstalledPluginIndexStoreOptions): Promise<Record<string, PluginInstallRecord> | null>;
export declare function readPersistedInstalledPluginIndexInstallRecordsSync(options?: InstalledPluginIndexStoreOptions): Record<string, PluginInstallRecord> | null;
export declare function loadInstalledPluginIndexInstallRecords(params?: InstalledPluginIndexStoreOptions): Promise<Record<string, PluginInstallRecord>>;
export declare function loadInstalledPluginIndexInstallRecordsSync(params?: InstalledPluginIndexStoreOptions): Record<string, PluginInstallRecord>;
