import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runYouSearch } from "./you-client.js";

function optionalStringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...options,
    }),
  );
}

const SAFESEARCH_VALUES = ["off", "moderate", "strict"] as const;

const GenericYouSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-100, default: 10).",
      minimum: 1,
      maximum: 100,
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        'Filter by recency: "day", "week", "month", "year", or a date range in the format "YYYY-MM-DDtoYYYY-MM-DD".',
    }),
  ),
  country: Type.Optional(
    Type.String({
      description: "Two-letter country code (e.g. US, GB, DE) to bias results.",
    }),
  ),
  safesearch: optionalStringEnum(SAFESEARCH_VALUES, {
    description: 'Safe search filter: "off", "moderate", or "strict".',
  }),
});

export function createYouWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "you",
    label: "You.com Search",
    hint: "Search, research & content extraction · $100 credit on signup",
    credentialLabel: "You.com API key",
    requiresCredential: false,
    envVars: ["YDC_API_KEY"],
    placeholder: "ydc-...",
    signupUrl: "https://you.com/platform",
    docsUrl: "https://docs.openclaw.ai/tools/you",
    onboardingScopes: ["text-inference"],
    // After Tavily (70), before DuckDuckGo (100)
    autoDetectOrder: 80,
    credentialPath: "plugins.entries.you.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.you.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "you"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "you", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "you")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "you", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "you").config,
    createTool: (ctx) => ({
      description:
        "Search the web using You.com. Returns structured results with snippets. Supports freshness, country, and safesearch filters. Use web_research for deep research with citations.",
      parameters: GenericYouSearchSchema,
      execute: async (args) =>
        await runYouSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
          freshness: typeof args.freshness === "string" ? args.freshness : undefined,
          country: typeof args.country === "string" ? args.country : undefined,
          safesearch: typeof args.safesearch === "string" ? args.safesearch : undefined,
        }),
    }),
  };
}
