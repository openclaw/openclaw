import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_PROVIDER_ID,
  getUnlistedOllamaConfiguredModelIds,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
} from "./src/discovery-shared.js";
import { buildOllamaProvider, capLocalOllamaProviderContext } from "./src/provider-models.js";

async function runOllamaDiscovery(ctx: ProviderCatalogContext) {
  return await resolveOllamaDiscoveryResult({
    ctx,
    pluginConfig: resolvePluginConfigObject(ctx.config, OLLAMA_PROVIDER_ID) ?? {},
    buildProvider: async (...args) =>
      capLocalOllamaProviderContext(await buildOllamaProvider(...args)),
  });
}

export const ollamaProviderDiscovery = {
  id: OLLAMA_PROVIDER_ID,
  label: "Ollama",
  docsPath: "/providers/ollama",
  envVars: ["OLLAMA_API_KEY"],
  auth: [],
  resolveSyntheticAuth: ({
    provider,
    providerConfig,
  }: {
    provider?: string;
    providerConfig?: ModelProviderConfig;
  }) => {
    if (!shouldUseSyntheticOllamaAuth(providerConfig)) {
      return undefined;
    }
    return {
      apiKey: OLLAMA_DEFAULT_API_KEY,
      source: `models.providers.${provider ?? OLLAMA_PROVIDER_ID} (synthetic local key)`,
      mode: "api-key",
    };
  },
  catalog: {
    order: "late",
    run: runOllamaDiscovery,
    getUnlistedConfiguredModelIds: getUnlistedOllamaConfiguredModelIds,
  },
} satisfies ProviderPlugin;

export default ollamaProviderDiscovery;
