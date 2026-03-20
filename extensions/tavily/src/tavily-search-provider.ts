import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { runTavilySearch } from "./tavily-client.js";

const GenericTavilySearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-20).",
        minimum: 1,
        maximum: 20,
      }),
    ),
  },
  { additionalProperties: false },
);

function getScopedCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  const scoped = searchConfig?.tavily;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return undefined;
  }
  return (scoped as Record<string, unknown>).apiKey;
}

function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  const scoped = searchConfigTarget.tavily;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    searchConfigTarget.tavily = { apiKey: value };
    return;
  }
  (scoped as Record<string, unknown>).apiKey = value;
}

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured results with domain filters and AI answer summaries",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    autoDetectOrder: 70,
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.tavily.config.webSearch.apiKey"],
    getCredentialValue: getScopedCredentialValue,
    setCredentialValue: setScopedCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "tavily")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "tavily", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "tavily").config,
    createTool: (ctx) => ({
      description:
        "Search the web using Tavily. Returns structured results with snippets. Use tavily_search for Tavily-specific options like search depth, topic filtering, or AI answers.",
      parameters: GenericTavilySearchSchema,
      execute: async (args) =>
        await runTavilySearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          maxResults: typeof args.count === "number" ? args.count : undefined,
        }),
    }),
  };
}
