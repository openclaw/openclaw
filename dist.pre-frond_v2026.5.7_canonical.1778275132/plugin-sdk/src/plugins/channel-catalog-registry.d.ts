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
}): PluginChannelCatalogEntry[];
