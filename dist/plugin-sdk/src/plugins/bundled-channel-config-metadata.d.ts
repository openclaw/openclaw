import type { OpenClawPackageManifest, PluginManifest, PluginManifestChannelConfig } from "./manifest.js";
export declare function collectBundledChannelConfigs(params: {
    pluginDir: string;
    manifest: PluginManifest;
    packageManifest?: OpenClawPackageManifest;
}): Record<string, PluginManifestChannelConfig> | undefined;
