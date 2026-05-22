import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { n as requireApiKey } from "./model-auth-runtime-shared-BGy5whmK.js";
import { d as ResolvedTtsConfig } from "./tts-runtime.types-CxTU0vS3.js";
import { a as getApiKeyForModel } from "./model-auth-GeBD2w1s.js";
import { a as normalizeProviderResolvedModelWithPlugin, i as buildProviderUnknownModelHintWithPlugin, l as runProviderDynamicModel, n as applyProviderResolvedTransportWithPlugin, o as normalizeProviderTransportWithPlugin, s as prepareProviderDynamicModel, t as applyProviderResolvedModelCompatWithPlugins, u as shouldPreferProviderRuntimeResolvedModel } from "./provider-runtime-3BFZonVS.js";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { Api, Model, completeSimple } from "@mariozechner/pi-ai";

//#region src/agents/pi-embedded-runner/model.d.ts
type ProviderRuntimeHooks = {
  applyProviderResolvedModelCompatWithPlugins?: (params: Parameters<typeof applyProviderResolvedModelCompatWithPlugins>[0]) => unknown;
  applyProviderResolvedTransportWithPlugin?: (params: Parameters<typeof applyProviderResolvedTransportWithPlugin>[0]) => unknown;
  buildProviderUnknownModelHintWithPlugin: (params: Parameters<typeof buildProviderUnknownModelHintWithPlugin>[0]) => string | undefined;
  prepareProviderDynamicModel: (params: Parameters<typeof prepareProviderDynamicModel>[0]) => Promise<void>;
  runProviderDynamicModel: (params: Parameters<typeof runProviderDynamicModel>[0]) => unknown;
  shouldPreferProviderRuntimeResolvedModel?: (params: Parameters<typeof shouldPreferProviderRuntimeResolvedModel>[0]) => boolean;
  normalizeProviderResolvedModelWithPlugin: (params: Parameters<typeof normalizeProviderResolvedModelWithPlugin>[0]) => unknown;
  normalizeProviderTransportWithPlugin: typeof normalizeProviderTransportWithPlugin;
};
declare function resolveModelAsync(provider: string, modelId: string, agentDir?: string, cfg?: OpenClawConfig, options?: {
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  allowBundledStaticCatalogFallback?: boolean;
  retryTransientProviderRuntimeMiss?: boolean;
  runtimeHooks?: ProviderRuntimeHooks;
  skipProviderRuntimeHooks?: boolean;
  skipPiDiscovery?: boolean;
  workspaceDir?: string;
}): Promise<{
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}>;
//#endregion
//#region src/agents/simple-completion-transport.d.ts
declare function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model<Api>;
//#endregion
//#region src/tts/tts-core.d.ts
type SummarizeTextDeps = {
  completeSimple: typeof completeSimple;
  getApiKeyForModel: typeof getApiKeyForModel;
  prepareModelForSimpleCompletion: typeof prepareModelForSimpleCompletion;
  requireApiKey: typeof requireApiKey;
  resolveModelAsync: typeof resolveModelAsync;
};
type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};
declare function summarizeText(params: {
  text: string;
  targetLength: number;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  timeoutMs: number;
}, deps?: SummarizeTextDeps): Promise<SummarizeResult>;
//#endregion
export { summarizeText as t };