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

const GenericYouSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-100, default: 10).",
        minimum: 1,
        maximum: 100,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createYouWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "you",
    label: "You.com Search",
    hint: "Free-tier search with optional API key for higher rate limits",
    credentialLabel: "You.com API key (optional)",
    envVars: ["YDC_API_KEY"],
    placeholder: "ydc-...",
    signupUrl: "https://you.com/platform",
    docsUrl: "https://docs.openclaw.ai/tools/you",
    // You.com supports free tier (no API key) so it goes after Tavily (70) but before DuckDuckGo (100)
    autoDetectOrder: 80,
    // requiresCredential: false means it can work without an API key
    requiresCredential: false,
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
        "Search the web using You.com. Returns structured results with snippets. Works without API key (free tier). Use web_research for deep research with citations.",
      parameters: GenericYouSearchSchema,
      execute: async (args) =>
        await runYouSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        }),
    }),
  };
}
