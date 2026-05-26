import { type ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelChoice } from "../onboard-types.js";
type ChannelCatalogEntry = {
    id: ChannelChoice;
    meta: ChannelMeta;
};
export declare function shouldShowChannelInSetup(meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">): boolean;
export type ResolvedChannelSetupEntries = {
    entries: ChannelCatalogEntry[];
    installedCatalogEntries: ChannelPluginCatalogEntry[];
    installableCatalogEntries: ChannelPluginCatalogEntry[];
    installedCatalogById: Map<ChannelChoice, ChannelPluginCatalogEntry>;
    installableCatalogById: Map<ChannelChoice, ChannelPluginCatalogEntry>;
};
export declare function listManifestInstalledChannelIds(params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): Set<ChannelChoice>;
export declare function isCatalogChannelInstalled(params: {
    cfg: OpenClawConfig;
    entry: ChannelPluginCatalogEntry;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): boolean;
export declare function resolveChannelSetupEntries(params: {
    cfg: OpenClawConfig;
    installedPlugins: ChannelPlugin[];
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): ResolvedChannelSetupEntries;
export {};
