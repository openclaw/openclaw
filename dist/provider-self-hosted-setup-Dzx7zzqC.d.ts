import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
import { i as AuthProfileCredential } from "./types-BwDj5PsX.js";
import { i as WizardPrompter } from "./prompts-DgKIGa-v.js";
import { At as ProviderAuthResult, Ot as ProviderAuthMethodNonInteractiveContext, Ut as ProviderDiscoveryContext } from "./types-Vx7Jq4_-2.js";

//#region src/agents/self-hosted-provider-defaults.d.ts
declare const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
declare const SELF_HOSTED_DEFAULT_MAX_TOKENS = 8192;
declare const SELF_HOSTED_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
//#endregion
//#region src/plugins/provider-self-hosted-setup.d.ts
declare function discoverOpenAICompatibleLocalModels(params: {
  baseUrl: string;
  apiKey?: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelDefinitionConfig[]>;
declare function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig;
type OpenAICompatibleSelfHostedProviderSetupParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};
type OpenAICompatibleSelfHostedProviderPromptResult = {
  config: OpenClawConfig;
  credential: AuthProfileCredential;
  modelId: string;
  modelRef: string;
  profileId: string;
};
declare function promptAndConfigureOpenAICompatibleSelfHostedProvider(params: OpenAICompatibleSelfHostedProviderSetupParams): Promise<OpenAICompatibleSelfHostedProviderPromptResult>;
declare function promptAndConfigureOpenAICompatibleSelfHostedProviderAuth(params: OpenAICompatibleSelfHostedProviderSetupParams): Promise<ProviderAuthResult>;
declare function discoverOpenAICompatibleSelfHostedProvider<T extends Record<string, unknown>>(params: {
  ctx: ProviderDiscoveryContext;
  providerId: string;
  buildProvider: (params: {
    apiKey?: string;
    baseUrl?: string;
  }) => Promise<T>;
}): Promise<{
  provider: T & {
    apiKey: string;
  };
} | null>;
declare function configureOpenAICompatibleSelfHostedProviderNonInteractive(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<OpenClawConfig | null>;
//#endregion
export { promptAndConfigureOpenAICompatibleSelfHostedProvider as a, SELF_HOSTED_DEFAULT_COST as c, discoverOpenAICompatibleSelfHostedProvider as i, SELF_HOSTED_DEFAULT_MAX_TOKENS as l, configureOpenAICompatibleSelfHostedProviderNonInteractive as n, promptAndConfigureOpenAICompatibleSelfHostedProviderAuth as o, discoverOpenAICompatibleLocalModels as r, SELF_HOSTED_DEFAULT_CONTEXT_WINDOW as s, applyProviderDefaultModel as t };