import { type LoadPluginRegistryParams, type PluginRegistryContributionKey, type PluginRegistrySnapshot } from "./plugin-registry.js";
export type ListManifestContributionIdsParams = LoadPluginRegistryParams & {
    contribution: PluginRegistryContributionKey;
    index?: PluginRegistrySnapshot;
    includeDisabled?: boolean;
};
export declare function listManifestContributionIds(params: ListManifestContributionIdsParams): readonly string[];
export declare function listManifestChannelContributionIds(params?: Omit<ListManifestContributionIdsParams, "contribution">): readonly string[];
export declare function listManifestProviderContributionIds(params?: Omit<ListManifestContributionIdsParams, "contribution">): readonly string[];
