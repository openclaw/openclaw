import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelApi, ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
export declare function applyOnboardAuthAgentModelsAndProviders(cfg: OpenClawConfig, params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providers: Record<string, ModelProviderConfig>;
}): OpenClawConfig;
export declare function applyAgentDefaultModelPrimary(cfg: OpenClawConfig, primary: string): OpenClawConfig;
export declare function applyProviderConfigWithDefaultModels(cfg: OpenClawConfig, params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
}): OpenClawConfig;
export declare function applyProviderConfigWithDefaultModel(cfg: OpenClawConfig, params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
}): OpenClawConfig;
export declare function applyProviderConfigWithModelCatalog(cfg: OpenClawConfig, params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
}): OpenClawConfig;
