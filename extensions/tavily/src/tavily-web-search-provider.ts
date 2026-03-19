import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setTopLevelCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string;
};

type TavilySearchResponse = {
  results?: TavilySearchResult[];
  response_time?: number;
  query?: string;
};

function resolveTavilyApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["TAVILY_API_KEY"])
  );
}

function createTavilySchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    include_answer: Type.Optional(
      Type.Boolean({
        description: "Include a direct answer to the query (default: false).",
      }),
    ),
    include_raw_content: Type.Optional(
      Type.Boolean({
        description: "Include raw HTML content from pages (default: false).",
      }),
    ),
    topic: Type.Optional(
      Type.String({
        description: "Search topic: 'general' or 'news' (default: 'general').",
        enum: ["general", "news"],
      }),
    ),
  });
}

function missingTavilyKeyPayload() {
  return {
    error: "missing_tavily_api_key",
    message: `web_search (tavily) needs a Tavily Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set TAVILY_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

async function runTavilySearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  include_answer?: boolean;
  include_raw_content?: boolean;
  topic?: string;
}): Promise<Array<Record<string, unknown>>> {
  const payload = {
    api_key: params.apiKey,
    query: params.query,
    max_results: params.count,
    include_answer: params.include_answer ?? false,
    include_raw_content: params.include_raw_content ?? false,
    topic: params.topic ?? "general",
  };

  return withTrustedWebSearchEndpoint(
    {
      url: TAVILY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Tavily Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as TavilySearchResponse;
      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((entry) => {
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const content = entry.content ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: content ? wrapWebContent(content, "web_search") : "",
          score: entry.score || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

function createTavilyToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Tavily Search API. Returns comprehensive search results with content snippets and relevance scores.",
    parameters: createTavilySchema(),
    execute: async (args) => {
      const apiKey = resolveTavilyApiKey(searchConfig);
      if (!apiKey) {
        return missingTavilyKeyPayload();
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const include_answer = params.include_answer === true;
      const include_raw_content = params.include_raw_content === true;
      const topic = readStringParam(params, "topic");

      const cacheKey = buildSearchCacheKey([
        "tavily",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        include_answer ? "with_answer" : "no_answer",
        include_raw_content ? "with_raw" : "no_raw",
        topic || "general",
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      const results = await runTavilySearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds,
        include_answer,
        include_raw_content,
        topic: topic as "general" | "news" | undefined,
      });

      const payload = {
        query,
        provider: "tavily",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "tavily",
          wrapped: true,
        },
        results,
      };
      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
  };
}

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Fast · comprehensive results · news support",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tavily-search",
    autoDetectOrder: 20,
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.tavily.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "tavily")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "tavily", "apiKey", value);
    },
    createTool: (ctx) =>
      createTavilyToolDefinition(
        (() => {
          const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
          const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "tavily");
          if (!pluginConfig) {
            return searchConfig;
          }
          return {
            ...(searchConfig ?? {}),
            ...(pluginConfig.apiKey === undefined ? {} : { apiKey: pluginConfig.apiKey }),
          } as SearchConfigRecord;
        })(),
      ),
  };
}
