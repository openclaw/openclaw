import type { PluginPackageInstall } from "./manifest.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
export type WebSearchInstallCatalogEntry = {
    pluginId: string;
    label: string;
    install: PluginPackageInstall;
    provider: PluginWebSearchProviderEntry;
    trustedSourceLinkedOfficialInstall?: boolean;
};
export declare function resolveWebSearchInstallCatalogEntries(): WebSearchInstallCatalogEntry[];
export declare function resolveWebSearchInstallCatalogEntry(params: {
    providerId?: string;
    pluginId?: string;
}): WebSearchInstallCatalogEntry | undefined;
