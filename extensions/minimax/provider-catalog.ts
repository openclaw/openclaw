import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
// Minimax provider module implements model/runtime integration.
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { MINIMAX_API_BASE_URL, buildMinimaxApiModelDefinition } from "./model-definitions.js";
import { MINIMAX_TEXT_MODEL_ORDER } from "./provider-models.js";

export function buildMinimaxModelDiscovery(
  { baseUrl, api }: Pick<ModelProviderConfig, "baseUrl" | "api">,
  authMode: "api_key" | "oauth" = "api_key",
): OpenAICompatibleModelDiscoveryOptions {
  const usesOpenAI = api === "openai-completions";
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return {
    endpointPath: usesOpenAI || basePath.endsWith("/v1") ? "models" : "v1/models",
    // Anthropic API keys use X-Api-Key; OpenAI-compatible catalogs and portal
    // OAuth use Bearer authentication.
    buildRequestHeaders: ({ apiKey, discoveryApiKey }): HeadersInit => {
      const requestApiKey = discoveryApiKey ?? apiKey;
      if (!requestApiKey) {
        return {};
      }
      return usesOpenAI || authMode === "oauth"
        ? { Authorization: `Bearer ${requestApiKey}` }
        : { "X-Api-Key": requestApiKey };
    },
  };
}

export function resolveMinimaxCatalogBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawHost = env.MINIMAX_API_HOST?.trim();
  if (!rawHost) {
    return MINIMAX_API_BASE_URL;
  }

  try {
    const url = new URL(rawHost);
    const basePath = url.pathname.replace(/\/+$/, "");
    if (basePath.endsWith("/anthropic")) {
      return `${url.origin}${basePath}`;
    }
    return `${url.origin}/anthropic`;
  } catch {
    return MINIMAX_API_BASE_URL;
  }
}

function buildMinimaxCatalog(): ModelDefinitionConfig[] {
  return MINIMAX_TEXT_MODEL_ORDER.map(buildMinimaxApiModelDefinition);
}

export function buildMinimaxProvider(env?: NodeJS.ProcessEnv): ModelProviderConfig {
  return {
    baseUrl: resolveMinimaxCatalogBaseUrl(env),
    api: "anthropic-messages",
    authHeader: true,
    models: buildMinimaxCatalog(),
  };
}

export function buildMinimaxPortalProvider(env?: NodeJS.ProcessEnv): ModelProviderConfig {
  return {
    baseUrl: resolveMinimaxCatalogBaseUrl(env),
    api: "anthropic-messages",
    authHeader: true,
    models: buildMinimaxCatalog(),
  };
}
