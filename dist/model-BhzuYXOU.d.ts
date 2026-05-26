import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as normalizeProviderResolvedModelWithPlugin, i as buildProviderUnknownModelHintWithPlugin, l as runProviderDynamicModel, n as applyProviderResolvedTransportWithPlugin, o as normalizeProviderTransportWithPlugin, s as prepareProviderDynamicModel, t as applyProviderResolvedModelCompatWithPlugins, u as shouldPreferProviderRuntimeResolvedModel } from "./provider-runtime-B73Bddav.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Api, Model } from "@earendil-works/pi-ai";

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
export { resolveModelAsync as t };