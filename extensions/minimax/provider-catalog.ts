import type { OpenAICompatibleModelDiscoveryOptions } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { MINIMAX_API_BASE_URL, buildMinimaxApiModelDefinition } from "./model-definitions.js";
import { MINIMAX_TEXT_MODEL_ORDER } from "./provider-models.js";

export function buildMinimaxModelDiscovery(
  { baseUrl, api }: Pick<ModelProviderConfig, "baseUrl" | "api">,
  authMode: "api_key" | "oauth" = "api_key",
): OpenAICompatibleModelDiscoveryOptions {
  const usesOpenAI = api === "openai-completions";
  // Configured bases are operator input. A base that cannot parse must reach the
  // shared strict catalog run, which reports it as unavailable instead of throwing.
  const basePath = URL.canParse(baseUrl) ? new URL(baseUrl).pathname.replace(/\/+$/, "") : "";
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

export function buildMinimaxProvider(env?: NodeJS.ProcessEnv): ModelProviderConfig {
  return {
    baseUrl: resolveMinimaxCatalogBaseUrl(env),
    api: "anthropic-messages",
    authHeader: true,
    models: MINIMAX_TEXT_MODEL_ORDER.map(buildMinimaxApiModelDefinition),
  };
}

export function buildMinimaxPortalProvider(env?: NodeJS.ProcessEnv): ModelProviderConfig {
  return buildMinimaxProvider(env);
}
