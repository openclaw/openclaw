import type { PluginInstallRecord } from "../config/types.plugins.js";
import { type PluginDiscoveryResult } from "./discovery.js";
import { type PluginPackageChannel, type PluginPackageInstall } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export type PluginChannelCatalogEntry = {
    pluginId: string;
    origin: PluginOrigin;
    packageName?: string;
    workspaceDir?: string;
    rootDir: string;
    channel: PluginPackageChannel;
    install?: PluginPackageInstall;
};
export declare function listChannelCatalogEntries(params?: {
    origin?: PluginOrigin;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Optional override.  When omitted and `origin !== "bundled"`, the persisted
     * plugin install ledger is loaded synchronously so that npm-installed
     * channels stored outside the discovery roots are visible to the catalog.
     * Bundled-only callers skip the load to avoid the disk read.
     */
    installRecords?: Record<string, PluginInstallRecord>;
    discovery?: PluginDiscoveryResult;
}): PluginChannelCatalogEntry[];
