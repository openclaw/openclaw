import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  WEB_SEARCH_QUERY_COUNT_PROPERTIES,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  hasPerplexityLegacyOverride,
  resolvePerplexityConfig,
  resolvePerplexityWebSearchRuntimeMetadata,
} from "./perplexity-web-search-provider.shared.js";

const PERPLEXITY_CREDENTIAL_PATH = "plugins.entries.perplexity.config.webSearch.apiKey";

const loadPerplexityWebSearchRuntime = createLazyRuntimeModule(
  () => import("./perplexity-web-search-provider.runtime.js"),
);

export function createPerplexityWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Requires Perplexity API key or OpenRouter API key · structured results",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Perplexity API key",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    docsUrl: "https://docs.openclaw.ai/perplexity",
    autoDetectOrder: 50,
    credentialPath: PERPLEXITY_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: PERPLEXITY_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "perplexity" },
      configuredCredential: { pluginId: "perplexity" },
    }),
    resolveRuntimeMetadata: resolvePerplexityWebSearchRuntimeMetadata,
    createTool: (ctx) => {
      const searchConfig = mergeScopedSearchConfig(
        ctx.searchConfig,
        "perplexity",
        resolveProviderWebSearchPluginConfig(ctx.config, "perplexity"),
      );
      const schemaTransport =
        ctx.runtimeMetadata?.perplexityTransport ??
        (hasPerplexityLegacyOverride(resolvePerplexityConfig(searchConfig))
          ? "chat_completions"
          : undefined);
      const properties: Record<string, unknown> = {
        ...WEB_SEARCH_QUERY_COUNT_PROPERTIES,
        freshness: {
          type: "string",
          description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
        },
      };

      if (schemaTransport !== "chat_completions") {
        properties.country = {
          type: "string",
          description: "Native Perplexity Search API only. 2-letter country code.",
        };
        properties.language = {
          type: "string",
          description: "Native Perplexity Search API only. ISO 639-1 language code.",
        };
        properties.date_after = {
          type: "string",
          description:
            "Native Perplexity Search API only. Only results published after this date (YYYY-MM-DD).",
        };
        properties.date_before = {
          type: "string",
          description:
            "Native Perplexity Search API only. Only results published before this date (YYYY-MM-DD).",
        };
        properties.domain_filter = {
          type: "array",
          items: { type: "string" },
          description: "Native Perplexity Search API only. Domain filter (max 20).",
        };
        properties.max_tokens = {
          type: "integer",
          description:
            "Native Perplexity Search API only. Total content budget across all results.",
          minimum: 1,
          maximum: 1000000,
        };
        properties.max_tokens_per_page = {
          type: "integer",
          description: "Native Perplexity Search API only. Max tokens extracted per page.",
          minimum: 1,
        };
      }

      return {
        description:
          schemaTransport === "chat_completions"
            ? "Search the web using Perplexity Sonar via Perplexity/OpenRouter chat completions. Returns AI-synthesized answers with citations from web-grounded search."
            : "Search the web using Perplexity. Runtime routing decides between native Search API and Sonar chat-completions compatibility. Structured filters are available on the native Search API path.",
        parameters: { type: "object", properties, required: ["query"] },
        execute: async (args, context) => {
          context?.signal?.throwIfAborted();
          const { executePerplexitySearch } = await loadPerplexityWebSearchRuntime();
          return await executePerplexitySearch(args, searchConfig, context?.signal);
        },
      };
    },
  };
}
