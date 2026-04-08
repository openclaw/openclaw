import { Type } from "@sinclair/typebox";
import {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  normalizeFreshness,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveBochaConfig } from "./bocha-web-search-provider.shared.js";

function createBochaSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results to return (1-${MAX_SEARCH_COUNT}). Default is ${DEFAULT_SEARCH_COUNT}.`,
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Time range (oneDay, oneWeek, oneMonth, oneYear, noLimit).",
      }),
    ),
    summary: Type.Optional(
      Type.Boolean({
        description: "Whether to return the original web content (summary).",
      }),
    ),
  });
}

function createBochaToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Bocha Web Search API. High quality web search best for Chinese content.",
    parameters: createBochaSchema(),
    execute: async (args) => {
      const { executeBochaSearch } = await import("./bocha-web-search-provider.runtime.js");
      return await executeBochaSearch(args, searchConfig);
    },
  };
}

export function createBochaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "bocha",
    label: "Bocha Web Search",
    hint: "High quality web search · best for Chinese content",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Bocha Web Search API key",
    envVars: ["BOCHA_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://open.bocha.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 12,
    credentialPath: "plugins.entries.bocha.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.bocha.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) =>
      getScopedCredentialValue(searchConfig, "bocha") ?? getTopLevelCredentialValue(searchConfig),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "bocha", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "bocha")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "bocha", "apiKey", value);
    },
    createTool: (ctx) =>
      createBochaToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "bocha",
          resolveProviderWebSearchPluginConfig(ctx.config, "bocha"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveBochaConfig,
  normalizeFreshness,
} as const;
