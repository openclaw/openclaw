import type { ChannelMeta } from "./types.js";
export type ChannelUiMetaEntry = {
    id: string;
    label: string;
    detailLabel: string;
    systemImage?: string;
};
export type ChannelUiCatalog = {
    entries: ChannelUiMetaEntry[];
    order: string[];
    labels: Record<string, string>;
    detailLabels: Record<string, string>;
    systemImages: Record<string, string>;
    byId: Record<string, ChannelUiMetaEntry>;
};
export type ChannelPluginCatalogEntry = {
    id: string;
    meta: ChannelMeta;
    install: {
        npmSpec: string;
        localPath?: string;
        defaultChoice?: "npm" | "local";
    };
};
type CatalogOptions = {
    workspaceDir?: string;
    catalogPaths?: string[];
};
export declare function buildChannelUiCatalog(plugins: Array<{
    id: string;
    meta: ChannelMeta;
}>): ChannelUiCatalog;
export declare function listChannelPluginCatalogEntries(options?: CatalogOptions): ChannelPluginCatalogEntry[];
export declare function getChannelPluginCatalogEntry(id: string, options?: CatalogOptions): ChannelPluginCatalogEntry | undefined;
export {};
