import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
  normalizeFreshness,
  normalizeToIsoDate,
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

type TavilyConfig = {
  searchDepth?: string;
};

type TavilySearchResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
  score?: number;
};

type TavilySearchResponse = {
  results?: TavilySearchResult[];
  query?: string;
};

function resolveTavilyConfig(searchConfig?: SearchConfigRecord): TavilyConfig {
  const tavily = searchConfig?.tavily;
  return tavily && typeof tavily === "object" && !Array.isArray(tavily)
    ? (tavily as TavilyConfig)
    : {};
}

function resolveTavilySearchDepth(tavily?: TavilyConfig): "basic" | "advanced" {
  return tavily?.searchDepth === "advanced" ? "advanced" : "basic";
}

function resolveTavilyApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["TAVILY_API_KEY"])
  );
}

function mapTavilyFreshness(freshness: string): string | undefined {
  const map: Record<string, string> = {
    day: "day",
    week: "week",
    month: "month",
    year: "year",
  };
  return map[freshness];
}

async function runTavilySearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  searchDepth: "basic" | "advanced";
  topic?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeRange?: string;
}): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.count,
    search_depth: params.searchDepth,
  };
  if (params.topic) {
    body.topic = params.topic;
  }
  if (params.includeDomains && params.includeDomains.length > 0) {
    body.include_domains = params.includeDomains;
  }
  if (params.excludeDomains && params.excludeDomains.length > 0) {
    body.exclude_domains = params.excludeDomains;
  }
  if (params.timeRange) {
    body.time_range = params.timeRange;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: TAVILY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
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
        const content = entry.content ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: content ? wrapWebContent(content, "web_search") : "",
          published: entry.published_date || undefined,
          siteName: resolveSiteName(url) || undefined,
          score: entry.score,
        };
      });
    },
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
    topic: Type.Optional(
      Type.String({
        description: "Search topic: 'general', 'news', or 'finance'. Default: 'general'.",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
      }),
    ),
    include_domains: Type.Optional(
      Type.String({
        description:
          "Comma-separated list of domains to restrict results to (e.g., 'github.com,docs.python.org').",
      }),
    ),
    exclude_domains: Type.Optional(
      Type.String({
        description: "Comma-separated list of domains to exclude from results.",
      }),
    ),
  });
}

function missingTavilyKeyPayload() {
  return {
    error: "missing_tavily_api_key",
    message: `web_search (tavily) needs a Tavily API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set TAVILY_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createTavilyToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const tavilyConfig = resolveTavilyConfig(searchConfig);
  const searchDepth = resolveTavilySearchDepth(tavilyConfig);

  return {
    description:
      "Search the web using Tavily Search API. Optimized for LLM consumption with relevance scoring. Supports topic filtering, domain restrictions, and time-based filtering.",
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

      const topic = readStringParam(params, "topic");
      if (topic && !["general", "news", "finance"].includes(topic)) {
        return {
          error: "invalid_topic",
          message: "topic must be 'general', 'news', or 'finance'.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const rawFreshness = readStringParam(params, "freshness");
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "tavily") : undefined;
      if (rawFreshness && !freshness) {
        return {
          error: "invalid_freshness",
          message: "freshness must be day, week, month, or year.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      const timeRange = freshness ? mapTavilyFreshness(freshness) : undefined;

      const rawIncludeDomains = readStringParam(params, "include_domains");
      const includeDomains = rawIncludeDomains
        ? rawIncludeDomains.split(",").map((d) => d.trim()).filter(Boolean)
        : undefined;

      const rawExcludeDomains = readStringParam(params, "exclude_domains");
      const excludeDomains = rawExcludeDomains
        ? rawExcludeDomains.split(",").map((d) => d.trim()).filter(Boolean)
        : undefined;

      const cacheKey = buildSearchCacheKey([
        "tavily",
        searchDepth,
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        topic,
        timeRange,
        rawIncludeDomains,
        rawExcludeDomains,
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
        searchDepth,
        topic: topic ?? undefined,
        includeDomains,
        excludeDomains,
        timeRange,
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
    hint: "LLM-optimized results · topic/domain/time filters",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://app.tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 5,
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
            tavily: {
              ...resolveTavilyConfig(searchConfig),
              ...pluginConfig,
            },
          } as SearchConfigRecord;
        })(),
      ),
  };
}
