import { Type } from "@sinclair/typebox";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  throwWebSearchApiError,
  type OpenClawConfig,
  type SearchConfigRecord,
  type WebSearchCredentialResolutionSource,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_TAVILY_BASE_URL = "https://api.tavily.com";
const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TAVILY_MODEL = "tavily/quick";
const TAVILY_KEY_PREFIXES = ["tvly-"];

type TavilyConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    domain?: string;
  }>;
  answer?: string;
  images?: string[];
};

function resolveTavilyConfig(
  config?: OpenClawConfig,
  searchConfig?: SearchConfigRecord,
): TavilyConfig {
  const pluginConfig = resolveProviderWebSearchPluginConfig(config, "tavily");
  if (pluginConfig) {
    return pluginConfig as TavilyConfig;
  }
  const tavily = (searchConfig as Record<string, unknown> | undefined)?.tavily;
  return tavily && typeof tavily === "object" && !Array.isArray(tavily)
    ? (tavily as TavilyConfig)
    : {};
}

function resolveTavilyApiKey(tavily?: TavilyConfig): {
  apiKey?: string;
  source: "config" | "tavily_env" | "none";
} {
  const fromConfig = readConfiguredSecretString(
    tavily?.apiKey,
    "plugins.entries.tavily.config.webSearch.apiKey",
  );

  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }
  // 直接从process.env读取，绕过readProviderEnvValue
  const fromTavilyEnv = process.env.TAVILY_API_KEY;

  if (fromTavilyEnv) {
    return { apiKey: fromTavilyEnv, source: "tavily_env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolveTavilyBaseUrl(tavily?: TavilyConfig): string {
  const fromConfig = typeof tavily?.baseUrl === "string" ? tavily.baseUrl.trim() : "";
  return fromConfig || DEFAULT_TAVILY_BASE_URL;
}

function resolveTavilyModel(tavily?: TavilyConfig): string {
  const model = typeof tavily?.model === "string" ? tavily.model.trim() : "";
  return model || DEFAULT_TAVILY_MODEL;
}

async function runTavilySearchApi(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  includeAnswer?: boolean;
  includeImages?: boolean;
  searchRecencyFilter?: string;
  searchLanguageFilter?: string[];
  searchDomainFilter?: string[];
}): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.count,
    include_answer: params.includeAnswer,
    include_images: params.includeImages,
  };
  if (params.searchRecencyFilter) body.search_recency_filter = params.searchRecencyFilter;
  if (params.searchLanguageFilter?.length)
    body.search_language_filter = params.searchLanguageFilter;
  if (params.searchDomainFilter?.length) body.search_domain_filter = params.searchDomainFilter;

  return withTrustedWebSearchEndpoint(
    {
      url: TAVILY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async (response) => {
      if (!response.ok) {
        return await throwWebSearchApiError(response, "Tavily Search");
      }
      const data = (await response.json()) as TavilySearchResponse;

      return (data.results ?? []).map((entry) => ({
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url ?? "",
        description: entry.content ? wrapWebContent(entry.content, "web_search") : "",
        score: entry.score,
        siteName: resolveSiteName(entry.url) || entry.domain || undefined,
      }));
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
    include_answer: Type.Optional(Type.Boolean({ description: "Include AI-generated answer." })),
    include_images: Type.Optional(Type.Boolean({ description: "Include images in results." })),
    freshness: Type.Optional(
      Type.String({ description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'." }),
    ),
    language: Type.Optional(
      Type.String({ description: "ISO 639-1 language code like 'en', 'zh', or 'ja'." }),
    ),
    domain_filter: Type.Optional(
      Type.Array(Type.String(), { description: "Domain filter (max 20)." }),
    ),
  });
}

function createTavilyToolDefinition(
  config?: OpenClawConfig,
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Tavily. Returns structured results with optional AI-generated answers and images.",
    parameters: createTavilySchema(),
    execute: async (args) => {
      const tavilyConfig = resolveTavilyConfig(config, searchConfig);
      const apiKeyResult = resolveTavilyApiKey(tavilyConfig);

      const runtime = {
        apiKey: apiKeyResult.apiKey,
        baseUrl: resolveTavilyBaseUrl(tavilyConfig),
        model: resolveTavilyModel(tavilyConfig),
      };

      if (!runtime.apiKey) {
        return {
          error: "missing_tavily_api_key",
          message:
            "web_search (tavily) needs an API key. Set TAVILY_API_KEY in the Gateway environment, or configure plugins.entries.tavily.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const includeAnswer = params.include_answer === true;
      const includeImages = params.include_images === true;
      const freshness = readStringParam(params, "freshness");
      const language = readStringParam(params, "language");
      const domainFilter = readStringArrayParam(params, "domain_filter");

      if (domainFilter?.length > 20) {
        return {
          error: "invalid_domain_filter",
          message: "domain_filter supports a maximum of 20 domains.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const cacheKey = buildSearchCacheKey([
        "tavily",
        runtime.baseUrl,
        runtime.model,
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        includeAnswer,
        includeImages,
        freshness,
        language,
        domainFilter?.join(","),
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const results = await runTavilySearchApi({
        query,
        apiKey: runtime.apiKey!,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        timeoutSeconds,
        includeAnswer,
        includeImages,
        searchRecencyFilter: freshness,
        searchLanguageFilter: language ? [language] : undefined,
        searchDomainFilter: domainFilter,
      });

      const payload: Record<string, unknown> = {
        query,
        provider: "tavily",
        model: runtime.model,
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

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured results · AI-generated answers · images · domain filters",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://app.tavily.com/signup",
    docsUrl: "https://docs.openclaw.ai/tavily",
    autoDetectOrder: 40,
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.tavily.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const tavily = searchConfig?.tavily;
      const apiKey =
        tavily && typeof tavily === "object" && !Array.isArray(tavily)
          ? (tavily as Record<string, unknown>).apiKey
          : undefined;
      return apiKey;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.tavily;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.tavily = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) => {
      const apiKey = resolveProviderWebSearchPluginConfig(config, "tavily")?.apiKey;
      return apiKey;
    },
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "tavily", "apiKey", value);
    },
    createTool: (ctx) => {
      return createTavilyToolDefinition(
        ctx.config,
        ctx.searchConfig as SearchConfigRecord | undefined,
      );
    },
  };
}

export const __testing = {
  resolveTavilyConfig,
  resolveTavilyApiKey,
  resolveTavilyBaseUrl,
  resolveTavilyModel,
} as const;
