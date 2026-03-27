import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  enablePluginInConfig,
  getScopedCredentialValue,
  mergeScopedSearchConfig,
  parseIsoDateRange,
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
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  throwWebSearchApiError,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_BAIDU_BASE_URL = "https://qianfan.baidubce.com/v2/ai_search";
const DEFAULT_BAIDU_MODEL = "ernie-4.5-turbo-32k";
const DEFAULT_BAIDU_SEARCH_SOURCE = "baidu_search_v2";
const BAIDU_DOCS_URL = "https://docs.openclaw.ai/tools/baidu-search";
const BAIDU_ENV_VARS = ["APPBUILDER_API_KEY", "APPBUILDER_TOKEN"];
const BAIDU_RECENCY_VALUES = new Set(["week", "month", "semiyear", "year"]);
const BAIDU_RECENCY_ALIASES: Record<string, string> = {
  pw: "week",
  pm: "month",
  py: "year",
};

type BaiduConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enableDeepSearch?: boolean;
};

type BaiduSearchGenerationResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  references?: Array<{
    url?: string;
    title?: string;
    website?: string;
    content?: string;
    date?: string;
    page_time?: string;
  }>;
  followup_queries?: string[];
  request_id?: string;
  requestId?: string;
  code?: number | string;
  message?: string;
  error?: {
    code?: number | string;
    message?: string;
  };
};

type BaiduCitation = {
  url: string;
  title?: string;
  siteName?: string;
  description?: string;
  published?: string;
};

const BaiduSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of web references to ground the answer with (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Baidu AppBuilder." })),
    language: Type.Optional(Type.String({ description: "Not supported by Baidu AppBuilder." })),
    freshness: Type.Optional(
      Type.String({
        description: 'Time filter: "week", "month", "semiyear", or "year".',
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description: "Only search pages published on or after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description: "Only search pages published on or before this date (YYYY-MM-DD).",
      }),
    ),
  },
  { additionalProperties: false },
);

function resolveBaiduConfig(searchConfig?: SearchConfigRecord): BaiduConfig {
  const baidu = searchConfig?.baidu;
  return baidu && typeof baidu === "object" && !Array.isArray(baidu) ? (baidu as BaiduConfig) : {};
}

function resolveBaiduApiKey(baidu?: BaiduConfig): string | undefined {
  return (
    readConfiguredSecretString(baidu?.apiKey, "tools.web.search.baidu.apiKey") ??
    readProviderEnvValue(BAIDU_ENV_VARS)
  );
}

function resolveBaiduBaseUrl(baidu?: BaiduConfig): string {
  const baseUrl = typeof baidu?.baseUrl === "string" ? baidu.baseUrl.trim() : "";
  return baseUrl || DEFAULT_BAIDU_BASE_URL;
}

function resolveBaiduModel(baidu?: BaiduConfig): string {
  const model = typeof baidu?.model === "string" ? baidu.model.trim() : "";
  return model || DEFAULT_BAIDU_MODEL;
}

function resolveBaiduEnableDeepSearch(baidu?: BaiduConfig): boolean {
  return baidu?.enableDeepSearch === true;
}

function resolveBaiduRecency(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (BAIDU_RECENCY_VALUES.has(normalized)) {
    return normalized;
  }
  return BAIDU_RECENCY_ALIASES[normalized];
}

function toBaiduRangeDateTimeStart(isoDate: string): string {
  return `${isoDate}T00:00:00Z`;
}

function toBaiduRangeDateTimeEndExclusive(isoDate: string): string {
  const end = new Date(`${isoDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString().replace(".000Z", "Z");
}

function buildBaiduPageTimeRange(
  dateAfter?: string,
  dateBefore?: string,
): {
  gte?: string;
  lt?: string;
} | null {
  if (!dateAfter && !dateBefore) {
    return null;
  }
  return {
    ...(dateAfter ? { gte: toBaiduRangeDateTimeStart(dateAfter) } : {}),
    ...(dateBefore ? { lt: toBaiduRangeDateTimeEndExclusive(dateBefore) } : {}),
  };
}

function buildUnsupportedBaiduFilterPayload(params: Record<string, unknown>):
  | {
      error: string;
      message: string;
      docs: string;
    }
  | undefined {
  const country = readStringParam(params, "country");
  if (country) {
    return {
      error: "unsupported_country",
      message:
        "country filtering is not supported by the baidu provider. Only Brave and Perplexity support country filtering.",
      docs: BAIDU_DOCS_URL,
    };
  }

  const language = readStringParam(params, "language");
  if (language) {
    return {
      error: "unsupported_language",
      message:
        "language filtering is not supported by the baidu provider. Only Brave and Perplexity support language filtering.",
      docs: BAIDU_DOCS_URL,
    };
  }

  return undefined;
}

function dedupeBaiduCitations(
  references: BaiduSearchGenerationResponse["references"],
): BaiduCitation[] {
  const citations = new Map<string, BaiduCitation>();
  for (const reference of references ?? []) {
    const url = typeof reference?.url === "string" ? reference.url.trim() : "";
    if (!url || citations.has(url)) {
      continue;
    }
    citations.set(url, {
      url,
      title:
        typeof reference?.title === "string" && reference.title.trim()
          ? wrapWebContent(reference.title.trim(), "web_search")
          : undefined,
      siteName:
        typeof reference?.website === "string" && reference.website.trim()
          ? reference.website.trim()
          : resolveSiteName(url) || undefined,
      description:
        typeof reference?.content === "string" && reference.content.trim()
          ? wrapWebContent(reference.content.trim(), "web_search")
          : undefined,
      published:
        typeof reference?.date === "string" && reference.date.trim()
          ? reference.date.trim()
          : typeof reference?.page_time === "string" && reference.page_time.trim()
            ? reference.page_time.trim()
            : undefined,
    });
  }
  return [...citations.values()];
}

async function runBaiduSearchGeneration(params: {
  query: string;
  count: number;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  enableDeepSearch: boolean;
  recency?: string;
  pageTimeRange?: {
    gte?: string;
    lt?: string;
  } | null;
}): Promise<{
  content: string;
  citations: BaiduCitation[];
  followupQueries: string[];
  requestId?: string;
}> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: params.model,
    messages: [{ role: "user", content: params.query }],
    search_source: DEFAULT_BAIDU_SEARCH_SOURCE,
    resource_type_filter: [{ type: "web", top_k: params.count }],
    stream: false,
    enable_followup_query: true,
    response_format: "text",
    enable_corner_markers: false,
  };

  if (params.enableDeepSearch) {
    body.enable_deep_search = true;
  }
  if (params.recency) {
    body.search_recency_filter = params.recency;
  }
  if (params.pageTimeRange && (params.pageTimeRange.gte || params.pageTimeRange.lt)) {
    body.search_filter = {
      range: {
        page_time: params.pageTimeRange,
      },
    };
  }

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "X-Appbuilder-Authorization": `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Baidu AppBuilder");
      }

      const data = (await res.json()) as BaiduSearchGenerationResponse;
      const errorCode = data.error?.code ?? data.code;
      const errorMessage = data.error?.message ?? data.message;
      if (
        data.error ||
        (errorCode !== undefined &&
          String(errorCode).trim().length > 0 &&
          String(errorCode).trim() !== "0")
      ) {
        throw new Error(
          `Baidu AppBuilder API error (${errorCode ?? "unknown"}): ${errorMessage ?? "unknown error"}`,
        );
      }

      const content = data.choices?.[0]?.message?.content?.trim() || "No response";
      return {
        content,
        citations: dedupeBaiduCitations(data.references),
        followupQueries: (data.followup_queries ?? []).filter(
          (query): query is string => typeof query === "string" && query.trim().length > 0,
        ),
        requestId:
          typeof data.request_id === "string" && data.request_id.trim()
            ? data.request_id.trim()
            : typeof data.requestId === "string" && data.requestId.trim()
              ? data.requestId.trim()
              : undefined,
      };
    },
  );
}

function missingBaiduKeyPayload(): Record<string, unknown> {
  return {
    error: "missing_baidu_api_key",
    message:
      "web_search (baidu) needs an AppBuilder API key. Set APPBUILDER_API_KEY in the Gateway environment, or configure plugins.entries.baidu.config.webSearch.apiKey.",
    docs: BAIDU_DOCS_URL,
  };
}

function createBaiduToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Baidu AppBuilder intelligent search generation. Returns AI-synthesized answers with citations from live Baidu Search results.",
    parameters: BaiduSearchSchema,
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const unsupported = buildUnsupportedBaiduFilterPayload(params);
      if (unsupported) {
        return unsupported;
      }

      const baiduConfig = resolveBaiduConfig(searchConfig);
      const apiKey = resolveBaiduApiKey(baiduConfig);
      if (!apiKey) {
        return missingBaiduKeyPayload();
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;

      const rawFreshness = readStringParam(params, "freshness");
      const freshness = resolveBaiduRecency(rawFreshness);
      if (rawFreshness && !freshness) {
        return {
          error: "invalid_freshness",
          message: 'freshness must be one of "week", "month", "semiyear", or "year".',
          docs: BAIDU_DOCS_URL,
        };
      }

      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");
      if (freshness && (rawDateAfter || rawDateBefore)) {
        return {
          error: "conflicting_time_filters",
          message:
            "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
          docs: BAIDU_DOCS_URL,
        };
      }

      const parsedDateRange = parseIsoDateRange({
        rawDateAfter,
        rawDateBefore,
        invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
        invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
        invalidDateRangeMessage: "date_after must be earlier than or equal to date_before.",
        docs: BAIDU_DOCS_URL,
      });
      if ("error" in parsedDateRange) {
        return parsedDateRange;
      }
      const { dateAfter, dateBefore } = parsedDateRange;

      const model = resolveBaiduModel(baiduConfig);
      const enableDeepSearch = resolveBaiduEnableDeepSearch(baiduConfig);
      const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const cacheKey = buildSearchCacheKey([
        "baidu",
        query,
        resolvedCount,
        model,
        freshness,
        dateAfter,
        dateBefore,
        enableDeepSearch,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runBaiduSearchGeneration({
        query,
        count: resolvedCount,
        apiKey,
        baseUrl: resolveBaiduBaseUrl(baiduConfig),
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        enableDeepSearch,
        recency: freshness,
        pageTimeRange: buildBaiduPageTimeRange(dateAfter, dateBefore),
      });
      const payload = {
        query,
        provider: "baidu",
        model,
        searchSource: DEFAULT_BAIDU_SEARCH_SOURCE,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "baidu",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
        ...(result.followupQueries.length > 0 ? { followupQueries: result.followupQueries } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createBaiduWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "baidu",
    label: "Baidu AI Search",
    hint: "AppBuilder intelligent search generation with Baidu Search grounding",
    credentialLabel: "Baidu AppBuilder API key",
    envVars: [...BAIDU_ENV_VARS],
    placeholder: "appbuilder_...",
    signupUrl: "https://appbuilder.baidu.com/",
    docsUrl: BAIDU_DOCS_URL,
    autoDetectOrder: 15,
    credentialPath: "plugins.entries.baidu.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.baidu.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "baidu"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "baidu", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "baidu")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "baidu", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "baidu").config,
    createTool: (ctx) =>
      createBaiduToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "baidu",
          resolveProviderWebSearchPluginConfig(ctx.config, "baidu"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveBaiduApiKey,
  resolveBaiduBaseUrl,
  resolveBaiduModel,
  resolveBaiduEnableDeepSearch,
  resolveBaiduRecency,
  buildBaiduPageTimeRange,
  dedupeBaiduCitations,
} as const;
