import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  OLLAMA_PROVIDER_ID,
  resolveOllamaDiscoveryResult,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  resolveOllamaApiBase,
} from "./src/provider-models.js";

const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;

type OllamaProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  envVars: string[];
  auth: [];
  discovery: {
    order: "late";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runOllamaDiscovery>;
  };
};

async function buildOllamaProvider(
  configuredBaseUrl?: string,
  opts?: { quiet?: boolean },
): Promise<ModelProviderConfig> {
  const apiBase = resolveOllamaApiBase(configuredBaseUrl);
  const { reachable, models } = await fetchOllamaModels(apiBase);
  if (!reachable && !opts?.quiet) {
    console.warn(`Ollama could not be reached at ${apiBase}.`);
  }
  const discovered = await enrichOllamaModelsWithContext(
    apiBase,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
  );
  return {
    baseUrl: apiBase,
    api: "ollama",
    models: discovered.map((model) =>
      buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities),
    ),
  };
}

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
  discovery: {
    order: "late",
    run: runOllamaDiscovery,
  },
};

export default ollamaProviderDiscovery;
