import { type PluginInstallSourceInfo } from "./install-source-info.js";
import type { PluginPackageInstall } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { type ProviderAuthChoiceMetadata } from "./provider-auth-choices.js";
export type ProviderInstallCatalogEntry = ProviderAuthChoiceMetadata & {
    label: string;
    origin: PluginOrigin;
    install: PluginPackageInstall;
    installSource?: PluginInstallSourceInfo;
};
type ProviderInstallCatalogParams = {
    config?: import("../config/types.openclaw.js").OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeUntrustedWorkspacePlugins?: boolean;
};
export declare function resolveProviderInstallCatalogEntries(params?: ProviderInstallCatalogParams): ProviderInstallCatalogEntry[];
export declare function resolveProviderInstallCatalogEntry(choiceId: string, params?: ProviderInstallCatalogParams): ProviderInstallCatalogEntry | undefined;
export {};
