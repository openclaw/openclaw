import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  OLLAMA_DEFAULT_API_KEY,
  OLLAMA_PROVIDER_ID,
  hasMeaningfulExplicitOllamaConfig,
  resolveOllamaDiscoveryResult,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import { buildOllamaProvider } from "./src/provider-models.js";

type OllamaProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  envVars: string[];
  auth: [];
  resolveSyntheticAuth: (ctx: { providerConfig?: ModelProviderConfig }) =>
    | {
        apiKey: string;
        source: string;
        mode: "api-key";
      }
    | undefined;
  discovery: {
    order: "late";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runOllamaDiscovery>;
  };
};

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
    buildProvider: buildOllamaProvider,
  });
}

export const ollamaProviderDiscovery: OllamaProviderPlugin = {
  id: OLLAMA_PROVIDER_ID,
  label: "Ollama",
  docsPath: "/providers/ollama",
  envVars: ["OLLAMA_API_KEY"],
  auth: [],
  resolveSyntheticAuth: ({ providerConfig }) => {
    if (!hasMeaningfulExplicitOllamaConfig(providerConfig)) {
      return undefined;
    }
    return {
      apiKey: OLLAMA_DEFAULT_API_KEY,
      source: "models.providers.ollama (synthetic local key)",
      mode: "api-key",
    };
  },
  discovery: {
    order: "late",
    run: runOllamaDiscovery,
  },
};

export default ollamaProviderDiscovery;
