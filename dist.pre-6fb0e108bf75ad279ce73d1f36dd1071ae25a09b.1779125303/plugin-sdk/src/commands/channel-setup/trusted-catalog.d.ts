import { type ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function getTrustedChannelPluginCatalogEntry(channelId: string, params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry | undefined;
export declare function listTrustedChannelPluginCatalogEntries(params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[];
export declare function listSetupDiscoveryChannelPluginCatalogEntries(params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[];
