import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type NormalizedPluginsConfig } from "./config-normalization-shared.js";
import type { BundledChannelConfigCollector, PluginManifestContractListKey, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { type PluginRegistryIdNormalizerOptions } from "./plugin-registry-id-normalizer.js";
import { type LoadPluginRegistryParams, type PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
export { createPluginRegistryIdNormalizer, type PluginRegistryIdNormalizerOptions, } from "./plugin-registry-id-normalizer.js";
export type PluginLookUpTable = Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "plugins" | "normalizePluginId" | "owners">;
export type PluginRegistryContributionOptions = LoadPluginRegistryParams & {
    includeDisabled?: boolean;
    lookUpTable?: PluginLookUpTable;
};
export type LoadPluginRegistryManifestParams = LoadPluginRegistryParams & {
    includeDisabled?: boolean;
    pluginIds?: readonly string[];
    bundledChannelConfigCollector?: BundledChannelConfigCollector;
};
export type PluginRegistryContributionKey = "providers" | "channels" | "channelConfigs" | "setupProviders" | "cliBackends" | "modelCatalogProviders" | "commandAliases" | "contracts";
export type ResolvePluginContributionOwnersParams = PluginRegistryContributionOptions & {
    contribution: PluginRegistryContributionKey;
    matches: string | ((contributionId: string) => boolean);
};
export type ListPluginContributionIdsParams = PluginRegistryContributionOptions & {
    contribution: PluginRegistryContributionKey;
};
export type ResolveProviderOwnersParams = PluginRegistryContributionOptions & {
    providerId: string;
};
export type ResolveChannelOwnersParams = PluginRegistryContributionOptions & {
    channelId: string;
};
export type ResolveCliBackendOwnersParams = PluginRegistryContributionOptions & {
    cliBackendId: string;
};
export type ResolveSetupProviderOwnersParams = PluginRegistryContributionOptions & {
    setupProviderId: string;
};
export type ResolveManifestContractPluginIdsParams = LoadPluginRegistryParams & {
    contract: PluginManifestContractListKey;
    origin?: PluginOrigin;
    onlyPluginIds?: readonly string[];
};
export type ResolveManifestContractOwnerPluginIdParams = LoadPluginRegistryParams & {
    contract: PluginManifestContractListKey;
    value: string | undefined;
    origin?: PluginOrigin;
};
export type ResolveManifestContractPluginIdsByCompatibilityRuntimePathParams = LoadPluginRegistryParams & {
    contract: PluginManifestContractListKey;
    path: string | undefined;
    origin?: PluginOrigin;
};
export declare function loadPluginManifestRegistryForPluginRegistry(params?: LoadPluginRegistryManifestParams): PluginManifestRegistry;
export declare function normalizePluginsConfigWithRegistry(config: OpenClawConfig["plugins"] | undefined, index: PluginRegistrySnapshot, options?: PluginRegistryIdNormalizerOptions): NormalizedPluginsConfig;
export declare function listPluginContributionIds(params: ListPluginContributionIdsParams): readonly string[];
export declare function resolvePluginContributionOwners(params: ResolvePluginContributionOwnersParams): readonly string[];
export declare function resolveProviderOwners(params: ResolveProviderOwnersParams): readonly string[];
export declare function resolveChannelOwners(params: ResolveChannelOwnersParams): readonly string[];
export declare function resolveCliBackendOwners(params: ResolveCliBackendOwnersParams): readonly string[];
export declare function resolveSetupProviderOwners(params: ResolveSetupProviderOwnersParams): readonly string[];
export declare function resolveManifestContractPluginIds(params: ResolveManifestContractPluginIdsParams): string[];
export declare function resolveManifestContractPluginIdsByCompatibilityRuntimePath(params: ResolveManifestContractPluginIdsByCompatibilityRuntimePathParams): string[];
export declare function resolveManifestContractOwnerPluginId(params: ResolveManifestContractOwnerPluginIdParams): string | undefined;
