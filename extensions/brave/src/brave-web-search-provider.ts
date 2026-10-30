/**
 * Brave web-search provider factory. It builds the agent tool definition and
 * lazy-loads HTTP execution only when a search is run.
 */
import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-flags";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search";
import {
  createWebSearchProviderContractFields,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  WEB_SEARCH_QUERY_COUNT_PROPERTIES,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBraveMode } from "../web-search-shared.js";

const BRAVE_CREDENTIAL_PATH = "plugins.entries.brave.config.webSearch.apiKey";

const loadBraveWebSearchRuntime = createLazyRuntimeModule(
  () => import("./brave-web-search-provider.runtime.js"),
);

const BraveSearchSchema = {
  type: "object",
  properties: {
    ...WEB_SEARCH_QUERY_COUNT_PROPERTIES,
    country: {
      type: "string",
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    },
    language: {
      type: "string",
      description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
    },
    freshness: {
      type: "string",
      description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
    },
    date_after: {
      type: "string",
      description: "Only results published after this date (YYYY-MM-DD).",
    },
    date_before: {
      type: "string",
      description: "Only results published before this date (YYYY-MM-DD).",
    },
    search_lang: {
      type: "string",
      description:
        "Brave language code for search results (e.g., 'en', 'de', 'en-gb', 'zh-hans', 'zh-hant', 'pt-br').",
    },
    ui_lang: {
      type: "string",
      description:
        "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag.",
    },
  },
} satisfies Record<string, unknown>;

export function createBraveWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Brave Search API key",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    docsUrl: "https://docs.openclaw.ai/tools/brave-search",
    autoDetectOrder: 10,
    credentialPath: BRAVE_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: BRAVE_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "brave" },
    }),
    createTool: (ctx) => {
      const searchConfig = mergeScopedSearchConfig(
        ctx.searchConfig,
        "brave",
        resolveProviderWebSearchPluginConfig(ctx.config, "brave"),
        { mirrorApiKeyToTopLevel: true },
      );
      const config = ctx.config;
      const braveMode = resolveBraveMode(asOptionalRecord(searchConfig?.brave));
      const diagnosticsEnabled = isDiagnosticFlagEnabled("brave.http", config);

      return {
        description:
          braveMode === "llm-context"
            ? "Search the web using Brave Search LLM Context API. Returns pre-extracted page content (text chunks, tables, code blocks) optimized for LLM grounding."
            : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
        parameters: BraveSearchSchema,
        execute: async (args, context) => {
          context?.signal?.throwIfAborted();
          const { executeBraveSearch } = await loadBraveWebSearchRuntime();
          return await executeBraveSearch(args, searchConfig, {
            diagnosticsEnabled,
            signal: context?.signal,
          });
        },
      };
    },
  };
}
