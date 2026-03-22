import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runSearXNGSearch } from "./searxng-client.js";

const SearXNGSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: 20,
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description:
          "Filter results by time range: 'pd' (day), 'pw' (week), 'pm' (month), 'py' (year).",
      }),
    ),
    search_lang: Type.Optional(
      Type.String({
        description: "ISO language code for search results (e.g., 'ko', 'en').",
      }),
    ),
  },
  { additionalProperties: false },
);

function freshnessToSearXNGTimeRange(freshness: string | undefined): string | undefined {
  if (!freshness) {
    return undefined;
  }
  const map: Record<string, string> = {
    pd: "day",
    pw: "week",
    pm: "month",
    py: "year",
  };
  return map[freshness] ?? undefined;
}

export function createSearXNGWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "searxng",
    label: "SearXNG",
    hint: "Privacy-focused metasearch engine (self-hosted)",
    credentialLabel: "SearXNG API key (optional)",
    envVars: ["SEARXNG_API_KEY"],
    placeholder: "Optional API key",
    signupUrl: "https://docs.searxng.org/",
    docsUrl: "https://docs.openclaw.ai/tools/searxng",
    autoDetectOrder: 80,
    credentialPath: "plugins.entries.searxng.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.searxng.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "searxng"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "searxng", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "searxng")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "searxng", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "searxng").config,
    createTool: (ctx) => ({
      description: "Search the web using a SearXNG instance. Returns snippets and URLs.",
      parameters: SearXNGSearchSchema,
      execute: async (args) =>
        await runSearXNGSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
          timeRange: freshnessToSearXNGTimeRange(
            typeof args.freshness === "string" ? args.freshness : undefined,
          ),
          language: typeof args.search_lang === "string" ? args.search_lang : undefined,
        }),
    }),
  };
}
