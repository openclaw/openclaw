import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "../../types.secrets-tbFW-hY6.js";
import { f as ModelProviderDeclarationConfig, s as ModelDefinitionConfig } from "../../types.models-tqxsISRc.js";
import { n as RuntimeEnv } from "../../runtime-Bxifh4bY.js";
import { i as WizardPrompter } from "../../prompts-DgKIGa-v.js";
import { t as SecretInputMode } from "../../provider-auth-types-C72FsWut.js";
import { f as resolveOllamaCompatNumCtxEnabled, l as isOllamaCompatProvider, m as wrapOllamaCompatNumCtx, o as createConfiguredOllamaCompatStreamWrapper, p as shouldInjectOllamaCompatNumCtx, r as buildOllamaChatRequest } from "../../stream-CI_Rrbq3.js";

//#region extensions/ollama/src/defaults.d.ts
declare const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
declare const OLLAMA_DEFAULT_CONTEXT_WINDOW = 128000;
declare const OLLAMA_DEFAULT_MAX_TOKENS = 8192;
declare const OLLAMA_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const OLLAMA_DEFAULT_MODEL = "gemma4";
//#endregion
//#region extensions/ollama/src/provider-models.d.ts
type OllamaTagModel = {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  remote_host?: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};
type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};
type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  capabilities?: string[];
};
declare function resolveOllamaApiBase(configuredBaseUrl?: string): string;
type OllamaModelShowInfo = {
  contextWindow?: number;
  capabilities?: string[];
};
declare function queryOllamaModelShowInfo(apiBase: string, modelName: string): Promise<OllamaModelShowInfo>;
/** @deprecated Use queryOllamaModelShowInfo instead. */
declare function queryOllamaContextWindow(apiBase: string, modelName: string): Promise<number | undefined>;
declare function enrichOllamaModelsWithContext(apiBase: string, models: OllamaTagModel[], opts?: {
  concurrency?: number;
}): Promise<OllamaModelWithContext[]>;
declare function isReasoningModelHeuristic(modelId: string): boolean;
declare function buildOllamaModelDefinition(modelId: string, contextWindow?: number, capabilities?: string[]): ModelDefinitionConfig;
declare function fetchOllamaModels(baseUrl: string): Promise<{
  reachable: boolean;
  models: OllamaTagModel[];
}>;
declare function buildOllamaProvider(configuredBaseUrl?: string, opts?: {
  quiet?: boolean;
}): Promise<ModelProviderDeclarationConfig>;
//#endregion
//#region extensions/ollama/src/setup.d.ts
type OllamaSetupOptions = {
  customBaseUrl?: string;
  customModelId?: string;
};
type OllamaSetupResult = {
  config: OpenClawConfig;
  credential: SecretInput;
  credentialMode?: SecretInputMode;
};
declare function promptAndConfigureOllama(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  opts?: Record<string, unknown>;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  allowSecretRefPrompt?: boolean;
}): Promise<OllamaSetupResult>;
declare function configureOllamaNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OllamaSetupOptions;
  runtime: RuntimeEnv;
  agentDir?: string;
}): Promise<OpenClawConfig>;
declare function ensureOllamaModelPulled(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
}): Promise<void>;
//#endregion
export { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_CONTEXT_WINDOW, OLLAMA_DEFAULT_COST, OLLAMA_DEFAULT_MAX_TOKENS, OLLAMA_DEFAULT_MODEL, type OllamaModelShowInfo, type OllamaModelWithContext, type OllamaTagModel, type OllamaTagsResponse, buildOllamaChatRequest, buildOllamaModelDefinition, buildOllamaProvider, configureOllamaNonInteractive, createConfiguredOllamaCompatStreamWrapper, enrichOllamaModelsWithContext, ensureOllamaModelPulled, fetchOllamaModels, isOllamaCompatProvider, isReasoningModelHeuristic, promptAndConfigureOllama, queryOllamaContextWindow, queryOllamaModelShowInfo, resolveOllamaApiBase, resolveOllamaCompatNumCtxEnabled, shouldInjectOllamaCompatNumCtx, wrapOllamaCompatNumCtx };