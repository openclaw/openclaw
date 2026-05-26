import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { InstalledPluginIndex, InstalledPluginInstallRecordInfo } from "./installed-plugin-index-types.js";
export declare function normalizeInstallRecordMap(records: Record<string, PluginInstallRecord> | undefined): Record<string, InstalledPluginInstallRecordInfo>;
export declare function extractPluginInstallRecordsFromInstalledPluginIndex(index: InstalledPluginIndex | null | undefined): Record<string, PluginInstallRecord>;
