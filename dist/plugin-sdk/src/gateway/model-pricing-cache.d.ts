import { type ModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataRegistryView } from "../plugins/plugin-metadata-snapshot.types.js";
import { getCachedGatewayModelPricing } from "./model-pricing-cache-state.js";
type GatewayModelPricingRefreshParams = {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    workspaceDir?: string;
    pluginMetadataSnapshot?: PluginMetadataRegistryView;
    pluginLookUpTable?: PluginMetadataRegistryView;
    manifestRegistry?: PluginManifestRegistry;
    signal?: AbortSignal;
};
export { getCachedGatewayModelPricing };
export declare function collectConfiguredModelPricingRefs(config: OpenClawConfig, options?: {
    manifestRegistry?: PluginManifestRegistry;
}): ModelRef[];
export declare function refreshGatewayModelPricingCache(params: GatewayModelPricingRefreshParams): Promise<void>;
export declare function startGatewayModelPricingRefresh(params: GatewayModelPricingRefreshParams): () => void;
export declare function __resetGatewayModelPricingCacheForTest(): void;
