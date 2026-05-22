import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
type ConfigCommit = (config: OpenClawConfig, writeOptions?: ConfigWriteOptions) => Promise<void>;
export declare function commitPluginInstallRecordsWithConfig(params: {
    previousInstallRecords?: Record<string, PluginInstallRecord>;
    nextInstallRecords: Record<string, PluginInstallRecord>;
    nextConfig: OpenClawConfig;
    baseHash?: string;
    writeOptions?: ConfigWriteOptions;
}): Promise<void>;
export declare function commitConfigWriteWithPendingPluginInstalls(params: {
    nextConfig: OpenClawConfig;
    writeOptions?: ConfigWriteOptions;
    commit: ConfigCommit;
}): Promise<{
    config: OpenClawConfig;
    installRecords: Record<string, PluginInstallRecord>;
    movedInstallRecords: boolean;
}>;
export declare function commitConfigWithPendingPluginInstalls(params: {
    nextConfig: OpenClawConfig;
    baseHash?: string;
    writeOptions?: ConfigWriteOptions;
}): Promise<{
    config: OpenClawConfig;
    installRecords: Record<string, PluginInstallRecord>;
    movedInstallRecords: boolean;
}>;
export {};
