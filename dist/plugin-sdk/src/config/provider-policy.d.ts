import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { ModelProviderConfig, OpenClawConfig } from "./types.js";
export declare function normalizeProviderConfigForConfigDefaults(params: {
    provider: string;
    providerConfig: ModelProviderConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): ModelProviderConfig;
export declare function applyProviderConfigDefaultsForConfig(params: {
    provider: string;
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): OpenClawConfig;
