import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
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
  setTopLevelCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const YEP_SEARCH_ENDPOINT = "https://platform.yep.com/api/search";

type YepSearchResult = {
  url?: string;
  title?: string;
  description?: string;
  snippet?: string;
  highlights?: string[];
};

type YepSearchResponse = {
  success?: boolean;
  request_id?: string;
  query?: string;
  type?: string;
  results?: YepSearchResult[];
  response_time_ms?: number;
  error?: string;
};

function resolveYepApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["YEP_API_KEY"])
  );
}

function normalizeYepLanguage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  // Yep accepts ISO 639-1 codes (e.g. "en", "de", "fr").
  return /^[a-z]{2}$/.test(trimmed) ? trimmed : undefined;
}

// Yep expects full URLs (e.g. "https://example.com"), not bare hostnames.
function normalizeYepDomains(value: string): string {
  return value
    .split(",")
    .map((d) => {
      const trimmed = d.trim();
      if (!trimmed) {
        return "";
      }
      return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    })
    .filter(Boolean)
    .join(",");
}

async function runYepSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  type?: string;
  searchMode?: string;
  language?: string;
  contentType?: string;
  safeSearch?: boolean;
  includeDomains?: string;
  excludeDomains?: string;
  dateAfter?: string;
  dateBefore?: string;
  crawlDateAfter?: string;
  crawlDateBefore?: string;
}): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    query: params.query,
    limit: params.count,
    type: params.type ?? "basic",
  };

  if (params.searchMode) {
    body.search_mode = params.searchMode;
  }
  if (params.language) {
    body.language = [params.language];
  }
  if (params.contentType) {
    body.content_type = params.contentType;
  }
  if (params.safeSearch != null) {
    body.safe_search = params.safeSearch;
  }
  if (params.includeDomains) {
    const normalized = normalizeYepDomains(params.includeDomains);
    if (normalized) {
      body.include_domains = normalized;
    }
  }
  if (params.excludeDomains) {
    const normalized = normalizeYepDomains(params.excludeDomains);
    if (normalized) {
      body.exclude_domains = normalized;
    }
  }
  if (params.dateAfter) {
    body.start_published_date = params.dateAfter;
  }
  if (params.dateBefore) {
    body.end_published_date = params.dateBefore;
  }
  if (params.crawlDateAfter) {
    body.start_crawl_date = params.crawlDateAfter;
  }
  if (params.crawlDateBefore) {
    body.end_crawl_date = params.crawlDateBefore;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: YEP_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Yep API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as YepSearchResponse;
      if (data.error) {
        throw new Error(`Yep API error: ${data.error}`);
      }
      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((entry) => {
        const description = entry.description ?? entry.snippet ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const mapped: Record<string, unknown> = {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          siteName: resolveSiteName(url) || undefined,
        };
        const highlights = (entry.highlights ?? []).filter(
          (h) => typeof h === "string" && h.length > 0,
        );
        if (highlights.length > 0) {
          mapped.highlights = highlights.map((h) => wrapWebContent(h, "web_search"));
        }
        return mapped;
      });
    },
  );
}

function createYepSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    result_type: Type.Optional(
      Type.String({
        description:
          "Result type: 'basic' (default, returns titles/URLs/descriptions) or 'highlights' (additionally includes relevant text highlights from page content).",
      }),
    ),
    search_mode: Type.Optional(
      Type.String({
        description: "Search mode: 'fast' or 'balanced' (default). Balanced combines speed and relevance.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
      }),
    ),
    content_type: Type.Optional(
      Type.String({
        description:
          "Filter by content type (e.g., 'Article', 'Video', 'Document', 'Listing'). Subtypes supported (e.g., 'Article/Tutorial_or_Guide').",
      }),
    ),
    safe_search: Type.Optional(
      Type.Boolean({
        description: "Exclude adult content (default: false).",
      }),
    ),
    include_domains: Type.Optional(
      Type.String({
        description: "Comma-separated list of domains to include in results.",
      }),
    ),
    exclude_domains: Type.Optional(
      Type.String({
        description: "Comma-separated list of domains to exclude from results.",
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description: "Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description: "Only results published before this date (YYYY-MM-DD).",
      }),
    ),
    crawl_date_after: Type.Optional(
      Type.String({
        description: "Only results crawled after this date (YYYY-MM-DD).",
      }),
    ),
    crawl_date_before: Type.Optional(
      Type.String({
        description: "Only results crawled before this date (YYYY-MM-DD).",
      }),
    ),
  });
}

function missingYepKeyPayload() {
  return {
    error: "missing_yep_api_key",
    message: `web_search (yep) needs a Yep API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set YEP_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createYepToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Yep (yep.com). Returns titles, URLs, and snippets from an independent search index. Supports language filtering and domain inclusion/exclusion.",
    parameters: createYepSchema(),
    execute: async (args) => {
      const apiKey = resolveYepApiKey(searchConfig);
      if (!apiKey) {
        return missingYepKeyPayload();
      }

      const params = args;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const rawType = readStringParam(params, "result_type");
      if (rawType && rawType !== "basic" && rawType !== "highlights") {
        return {
          error: "invalid_result_type",
          message: "result_type must be 'basic' or 'highlights'.",
        };
      }
      const yepType = rawType as "basic" | "highlights" | undefined;
      const rawSearchMode = readStringParam(params, "search_mode");
      if (rawSearchMode && rawSearchMode !== "fast" && rawSearchMode !== "balanced") {
        return {
          error: "invalid_search_mode",
          message: "search_mode must be 'fast' or 'balanced'.",
        };
      }
      const searchMode = rawSearchMode as "fast" | "balanced" | undefined;
      const rawLanguage = readStringParam(params, "language");
      const language = normalizeYepLanguage(rawLanguage);
      if (rawLanguage && !language) {
        return {
          error: "invalid_language",
          message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
        };
      }
      const contentType = readStringParam(params, "content_type");
      const safeSearch =
        typeof params.safe_search === "boolean" ? params.safe_search : undefined;
      const includeDomains = readStringParam(params, "include_domains");
      const excludeDomains = readStringParam(params, "exclude_domains");

      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");

      const rawCrawlDateAfter = readStringParam(params, "crawl_date_after");
      const rawCrawlDateBefore = readStringParam(params, "crawl_date_before");
      const parsedDateRange = parseIsoDateRange({
        rawDateAfter,
        rawDateBefore,
        invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
        invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
        invalidDateRangeMessage: "date_after must be before date_before.",
      });
      if ("error" in parsedDateRange) {
        return parsedDateRange;
      }
      const { dateAfter, dateBefore } = parsedDateRange;

      const parsedCrawlDateRange = parseIsoDateRange({
        rawDateAfter: rawCrawlDateAfter,
        rawDateBefore: rawCrawlDateBefore,
        invalidDateAfterMessage: "crawl_date_after must be YYYY-MM-DD format.",
        invalidDateBeforeMessage: "crawl_date_before must be YYYY-MM-DD format.",
        invalidDateRangeMessage: "crawl_date_after must be before crawl_date_before.",
      });
      if ("error" in parsedCrawlDateRange) {
        return parsedCrawlDateRange;
      }
      const { dateAfter: crawlDateAfter, dateBefore: crawlDateBefore } = parsedCrawlDateRange;

      const cacheKey = buildSearchCacheKey([
        "yep",
        yepType,
        searchMode,
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        language,
        contentType,
        safeSearch,
        includeDomains,
        excludeDomains,
        dateAfter,
        dateBefore,
        crawlDateAfter,
        crawlDateBefore,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const results = await runYepSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        type: yepType,
        searchMode,
        language,
        contentType,
        safeSearch,
        includeDomains,
        excludeDomains,
        dateAfter,
        dateBefore,
        crawlDateAfter,
        crawlDateBefore,
      });

      const payload = {
        query,
        provider: "yep",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "yep",
          wrapped: true,
        },
        results,
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createYepWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "yep",
    label: "Yep",
    hint: "Independent search index · domain filtering",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Yep API key",
    envVars: ["YEP_API_KEY"],
    placeholder: "yep_...",
    signupUrl: "https://platform.yep.com/",
    docsUrl: "https://docs.openclaw.ai/tools/yep-search",
    autoDetectOrder: 15,
    credentialPath: "plugins.entries.yep.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.yep.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "yep")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "yep", "apiKey", value);
    },
    createTool: (ctx) =>
      createYepToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "yep",
          resolveProviderWebSearchPluginConfig(ctx.config, "yep"),
          { mirrorApiKeyToTopLevel: true },
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  normalizeYepDomains,
  normalizeYepLanguage,
  resolveYepApiKey,
  YEP_SEARCH_ENDPOINT,
} as const;
