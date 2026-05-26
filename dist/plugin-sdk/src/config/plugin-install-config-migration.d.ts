import type { PluginInstallRecord } from "./types.plugins.js";
export declare function extractShippedPluginInstallConfigRecords(config: unknown): Record<string, PluginInstallRecord>;
export declare function stripShippedPluginInstallConfigRecords(config: unknown): unknown;
