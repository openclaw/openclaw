import { type PluginCandidate } from "./discovery.js";
import type { LoadInstalledPluginIndexParams } from "./installed-plugin-index-types.js";
import { type PluginManifestRegistry } from "./manifest-registry.js";
export declare function resolveInstalledPluginIndexRegistry(params: LoadInstalledPluginIndexParams): {
    registry: PluginManifestRegistry;
    candidates: readonly PluginCandidate[];
};
