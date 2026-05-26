import type { PluginInstallRecord } from "../config/types.plugins.js";
import { type BundledPluginSource } from "./bundled-sources.js";
export type StaleLocalBundledPluginInstallRecord = {
    pluginId: string;
    record: PluginInstallRecord;
    recordPathField: "installPath" | "sourcePath";
    stalePath: string;
    bundledPath: string;
};
export declare function listStaleLocalBundledPluginInstallRecords(params: {
    installRecords: Record<string, PluginInstallRecord>;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    bundled?: ReadonlyMap<string, BundledPluginSource>;
}): StaleLocalBundledPluginInstallRecord[];
export declare function pruneStaleLocalBundledPluginInstallRecords(params: {
    installRecords: Record<string, PluginInstallRecord>;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    bundled?: ReadonlyMap<string, BundledPluginSource>;
}): {
    records: Record<string, PluginInstallRecord>;
    stale: StaleLocalBundledPluginInstallRecord[];
};
