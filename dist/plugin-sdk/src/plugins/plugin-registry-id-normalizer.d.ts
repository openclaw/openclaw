import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
export type PluginRegistryIdNormalizerOptions = {
    manifestRegistry?: PluginManifestRegistry;
    lookUpTable?: Pick<{
        manifestRegistry: PluginManifestRegistry;
    }, "manifestRegistry">;
};
export declare function createPluginRegistryIdNormalizer(index: InstalledPluginIndex, options?: PluginRegistryIdNormalizerOptions): (pluginId: string) => string;
