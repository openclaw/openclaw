import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  requestXaiWebSearch,
  resolveXaiInlineCitations,
  resolveXaiSearchConfig,
  resolveXaiWebSearchModel,
} from "./web-search-shared.js";

function resolveGrokApiKey(grok?: Record<string, unknown>): string | undefined {
  return (
    readConfiguredSecretString(grok?.apiKey, "tools.web.search.grok.apiKey") ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

function createGrokSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    language: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Grok." })),
  });
}

function createGrokToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
    parameters: createGrokSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(params, "grok");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const grokConfig = resolveXaiSearchConfig(searchConfig);
      const apiKey = resolveGrokApiKey(grokConfig);
      if (!apiKey) {
        return {
          error: "missing_xai_api_key",
          message:
            "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveXaiWebSearchModel(searchConfig);
      const inlineCitations = resolveXaiInlineCitations(searchConfig);
      const cacheKey = buildSearchCacheKey([
        "grok",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        model,
        inlineCitations,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await requestXaiWebSearch({
        query,
        apiKey,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        inlineCitations,
      });
      const payload = buildXaiWebSearchPayload({
        query,
        provider: "grok",
        model,
        tookMs: Date.now() - start,
        content: result.content,
        citations: result.citations,
        inlineCitations: result.inlineCitations,
      });
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createGrokWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "grok"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "grok", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "xai")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "xai", "apiKey", value);
    },
    createTool: (ctx) =>
      createGrokToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "grok",
          resolveProviderWebSearchPluginConfig(ctx.config, "xai"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveGrokApiKey,
  resolveGrokModel: (grok?: Record<string, unknown>) =>
    resolveXaiWebSearchModel(grok ? { grok } : undefined),
  resolveGrokInlineCitations: (grok?: Record<string, unknown>) =>
    resolveXaiInlineCitations(grok ? { grok } : undefined),
  extractGrokContent: extractXaiWebSearchContent,
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiSearchConfig,
  resolveXaiWebSearchModel,
  requestXaiWebSearch,
  buildXaiWebSearchPayload,
} as const;
