import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_PROVIDER_ID,
  resolveOllamaDiscoveryResult,
  shouldUseSyntheticOllamaAuth,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import { buildOllamaProvider, capLocalOllamaProviderContext } from "./src/provider-models.js";

function resolveOllamaPluginConfig(ctx: ProviderCatalogContext): OllamaPluginConfig {
  const entries = (ctx.config.plugins?.entries ?? {}) as Record<
    string,
    { config?: OllamaPluginConfig }
  >;
  return entries.ollama?.config ?? {};
}

async function runOllamaDiscovery(ctx: ProviderCatalogContext) {
  return await resolveOllamaDiscoveryResult({
    ctx,
    pluginConfig: resolveOllamaPluginConfig(ctx),
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
  },
} satisfies ProviderPlugin;

export default ollamaProviderDiscovery;
