import type { Api, Model } from "@mariozechner/pi-ai";
import { type AuthStorage, type ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyProviderResolvedModelCompatWithPlugins, applyProviderResolvedTransportWithPlugin, buildProviderUnknownModelHintWithPlugin, normalizeProviderTransportWithPlugin, prepareProviderDynamicModel, runProviderDynamicModel, normalizeProviderResolvedModelWithPlugin, shouldPreferProviderRuntimeResolvedModel } from "../../plugins/provider-runtime.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
type ProviderRuntimeHooks = {
    applyProviderResolvedModelCompatWithPlugins?: (params: Parameters<typeof applyProviderResolvedModelCompatWithPlugins>[0]) => unknown;
    applyProviderResolvedTransportWithPlugin?: (params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0]) => unknown;
    buildProviderUnknownModelHintWithPlugin: (params: Parameters<typeof buildProviderUnknownModelHintWithPlugin>[0]) => string | undefined;
    prepareProviderDynamicModel: (params: Parameters<typeof prepareProviderDynamicModel>[0]) => Promise<void>;
    runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
    shouldPreferProviderRuntimeResolvedModel?: (params: Parameters<typeof shouldPreferProviderRuntimeResolvedModel>[0]) => boolean;
    normalizeProviderResolvedModelWithPlugin: (params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0]) => unknown;
    normalizeProviderTransportWithPlugin: (params: Parameters<typeof normalizeProviderTransportWithPlugin>[0]) => unknown;
};
export { buildModelAliasLines, buildInlineProviderModels };
export declare function resolveModelWithRegistry(params: {
    provider: string;
    modelId: string;
    modelRegistry: ModelRegistry;
    cfg?: OpenClawConfig;
    agentDir?: string;
    runtimeHooks?: ProviderRuntimeHooks;
}): Model<Api> | undefined;
export declare function resolveModel(provider: string, modelId: string, agentDir?: string, cfg?: OpenClawConfig, options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
}): {
    model?: Model<Api>;
    error?: string;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
};
export declare function resolveModelAsync(provider: string, modelId: string, agentDir?: string, cfg?: OpenClawConfig, options?: {
    authStorage?: AuthStorage;
    modelRegistry?: ModelRegistry;
    retryTransientProviderRuntimeMiss?: boolean;
    runtimeHooks?: ProviderRuntimeHooks;
    skipProviderRuntimeHooks?: boolean;
    skipPiDiscovery?: boolean;
}): Promise<{
    model?: Model<Api>;
    error?: string;
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
}>;
