import { i as OpenClawConfig, wn as AgentModelEntryConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as ModelApi, s as ModelDefinitionConfig, u as ModelProviderConfig } from "./types.models-tqxsISRc.js";

//#region src/plugin-sdk/provider-onboard.d.ts
type AgentModelAliasEntry = string | {
  modelRef: string;
  alias?: string;
};
declare const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";
type ProviderOnboardPresetAppliers<TArgs extends unknown[]> = {
  applyProviderConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
  applyConfig: (cfg: OpenClawConfig, ...args: TArgs) => OpenClawConfig;
};
declare function withAgentModelAliases(existing: Record<string, AgentModelEntryConfig> | undefined, aliases: readonly AgentModelAliasEntry[]): Record<string, AgentModelEntryConfig>;
declare function applyOnboardAuthAgentModelsAndProviders(cfg: OpenClawConfig, params: {
  agentModels: Record<string, AgentModelEntryConfig>;
  providers: Record<string, ModelProviderConfig>;
}): OpenClawConfig;
declare function applyAgentDefaultModelPrimary(cfg: OpenClawConfig, primary: string): OpenClawConfig;
declare function applyOpencodeZenModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
};
declare function applyProviderConfigWithDefaultModels(cfg: OpenClawConfig, params: {
  agentModels: Record<string, AgentModelEntryConfig>;
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  defaultModels: ModelDefinitionConfig[];
  defaultModelId?: string;
}): OpenClawConfig;
declare function applyProviderConfigWithDefaultModel(cfg: OpenClawConfig, params: {
  agentModels: Record<string, AgentModelEntryConfig>;
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  defaultModel: ModelDefinitionConfig;
  defaultModelId?: string;
}): OpenClawConfig;
declare function applyProviderConfigWithDefaultModelPreset(cfg: OpenClawConfig, params: {
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  defaultModel: ModelDefinitionConfig;
  defaultModelId?: string;
  aliases?: readonly AgentModelAliasEntry[];
  primaryModelRef?: string;
}): OpenClawConfig;
declare function createDefaultModelPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => Omit<Parameters<typeof applyProviderConfigWithDefaultModelPreset>[1], "primaryModelRef"> | null | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs>;
declare function applyProviderConfigWithDefaultModelsPreset(cfg: OpenClawConfig, params: {
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  defaultModels: ModelDefinitionConfig[];
  defaultModelId?: string;
  aliases?: readonly AgentModelAliasEntry[];
  primaryModelRef?: string;
}): OpenClawConfig;
declare function createDefaultModelsPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => Omit<Parameters<typeof applyProviderConfigWithDefaultModelsPreset>[1], "primaryModelRef"> | null | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs>;
declare function applyProviderConfigWithModelCatalog(cfg: OpenClawConfig, params: {
  agentModels: Record<string, AgentModelEntryConfig>;
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  catalogModels: ModelDefinitionConfig[];
}): OpenClawConfig;
declare function applyProviderConfigWithModelCatalogPreset(cfg: OpenClawConfig, params: {
  providerId: string;
  api: ModelApi;
  baseUrl: string;
  catalogModels: ModelDefinitionConfig[];
  aliases?: readonly AgentModelAliasEntry[];
  primaryModelRef?: string;
}): OpenClawConfig;
declare function createModelCatalogPresetAppliers<TArgs extends unknown[]>(params: {
  resolveParams: (cfg: OpenClawConfig, ...args: TArgs) => Omit<Parameters<typeof applyProviderConfigWithModelCatalogPreset>[1], "primaryModelRef"> | null | undefined;
  primaryModelRef: string;
}): ProviderOnboardPresetAppliers<TArgs>;
declare function ensureModelAllowlistEntry(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  defaultProvider?: string;
}): OpenClawConfig;
//#endregion
export { withAgentModelAliases as _, applyOnboardAuthAgentModelsAndProviders as a, applyProviderConfigWithDefaultModelPreset as c, applyProviderConfigWithModelCatalog as d, applyProviderConfigWithModelCatalogPreset as f, ensureModelAllowlistEntry as g, createModelCatalogPresetAppliers as h, applyAgentDefaultModelPrimary as i, applyProviderConfigWithDefaultModels as l, createDefaultModelsPresetAppliers as m, OPENCODE_ZEN_DEFAULT_MODEL as n, applyOpencodeZenModelDefault as o, createDefaultModelPresetAppliers as p, ProviderOnboardPresetAppliers as r, applyProviderConfigWithDefaultModel as s, AgentModelAliasEntry as t, applyProviderConfigWithDefaultModelsPreset as u };