import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords, loadInstalledPluginIndexInstallRecordsSync, readPersistedInstalledPluginIndexInstallRecords, readPersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { type RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
import { type PluginInstallUpdate } from "./installs.js";
export { loadInstalledPluginIndexInstallRecords, loadInstalledPluginIndexInstallRecordsSync, readPersistedInstalledPluginIndexInstallRecords, readPersistedInstalledPluginIndexInstallRecordsSync, };
export declare const PLUGIN_INSTALLS_CONFIG_PATH: readonly ["plugins", "installs"];
export type InstalledPluginIndexRecordStoreOptions = {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    filePath?: string;
};
type InstalledPluginIndexRecordRefreshOptions = InstalledPluginIndexRecordStoreOptions & Partial<Omit<RefreshInstalledPluginIndexParams, "reason" | "installRecords">> & {
    now?: () => Date;
};
export declare function resolveInstalledPluginIndexRecordsStorePath(options?: InstalledPluginIndexRecordStoreOptions): string;
export declare function writePersistedInstalledPluginIndexInstallRecords(records: Record<string, PluginInstallRecord>, options?: InstalledPluginIndexRecordRefreshOptions): Promise<string>;
export declare function writePersistedInstalledPluginIndexInstallRecordsSync(records: Record<string, PluginInstallRecord>, options?: InstalledPluginIndexRecordRefreshOptions): string;
export declare function withPluginInstallRecords(config: OpenClawConfig, records: Record<string, PluginInstallRecord>): OpenClawConfig;
export declare function withoutPluginInstallRecords(config: OpenClawConfig): OpenClawConfig;
export declare function recordPluginInstallInRecords(records: Record<string, PluginInstallRecord>, update: PluginInstallUpdate): Record<string, PluginInstallRecord>;
export declare function removePluginInstallRecordFromRecords(records: Record<string, PluginInstallRecord>, pluginId: string): Record<string, PluginInstallRecord>;
