import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { ModelApi, ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type { OpenClawConfig, ModelApi, ModelDefinitionConfig, ModelProviderConfig };
export { resolveAgentModelFallbackValues, resolveAgentModelPrimaryValue, } from "../config/model-input.js";
export type AgentModelAliasEntry = string | {
    modelRef: string;
    alias?: string;
};
export declare const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";
export type ProviderOnboardPresetAppliers<TArgs extends unknown[]> = {
    applyProviderConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
    applyConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
};
export declare function withAgentModelAliases(existing: Record<string, AgentModelEntryConfig> | undefined, aliases: readonly AgentModelAliasEntry[]): Record<string, AgentModelEntryConfig>;
export declare function applyOnboardAuthAgentModelsAndProviders(cfg: OpenClawConfig, params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providers: Record<string, ModelProviderConfig>;
}): OpenClawConfig;
export declare function applyAgentDefaultModelPrimary(cfg: OpenClawConfig, primary: string): OpenClawConfig;
export declare function applyOpencodeZenModelDefault(cfg: OpenClawConfig): {
    next: OpenClawConfig;
    changed: boolean;
};
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
export declare function applyProviderConfigWithDefaultModelPreset(cfg: OpenClawConfig, params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModel: ModelDefinitionConfig;
    defaultModelId?: string;
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
}): OpenClawConfig;
export declare function createDefaultModelPresetAppliers<TArgs extends unknown[]>(params: {
    resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => Omit<Parameters<typeof applyProviderConfigWithDefaultModelPreset>[1], "primaryModelRef"> | null | undefined;
    primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs>;
export declare function applyProviderConfigWithDefaultModelsPreset(cfg: OpenClawConfig, params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    defaultModels: ModelDefinitionConfig[];
    defaultModelId?: string;
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
}): OpenClawConfig;
export declare function createDefaultModelsPresetAppliers<TArgs extends unknown[]>(params: {
    resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => Omit<Parameters<typeof applyProviderConfigWithDefaultModelsPreset>[1], "primaryModelRef"> | null | undefined;
    primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs>;
export declare function applyProviderConfigWithModelCatalog(cfg: OpenClawConfig, params: {
    agentModels: Record<string, AgentModelEntryConfig>;
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
}): OpenClawConfig;
export declare function applyProviderConfigWithModelCatalogPreset(cfg: OpenClawConfig, params: {
    providerId: string;
    api: ModelApi;
    baseUrl: string;
    catalogModels: ModelDefinitionConfig[];
    aliases?: readonly AgentModelAliasEntry[];
    primaryModelRef?: string;
}): OpenClawConfig;
export declare function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
    resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => Omit<Parameters<typeof applyProviderConfigWithModelCatalogPreset>[1], "primaryModelRef"> | null | undefined;
    primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs>;
export declare function ensureModelAllowlistEntry(params: {
    cfg: OpenClawConfig;
    modelRef: string;
    defaultProvider?: string;
}): OpenClawConfig;
