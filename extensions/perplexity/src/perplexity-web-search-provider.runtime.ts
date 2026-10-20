import {
  readProviderJsonResponse,
  resolveProviderRequestHeaders,
} from "openclaw/plugin-sdk/provider-http";
import {
  externalContentStamp,
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  isoToPerplexityDate,
  normalizeFreshness,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringArrayParam,
  readStringParam,
  readWebSearchQueryAndCount,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  throwWebSearchApiError,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isDirectPerplexityBaseUrl,
  resolvePerplexityConfig,
  resolvePerplexityRuntime,
  type PerplexityAuth,
  type PerplexityConfig,
} from "./perplexity-web-search-provider.shared.js";

const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        url_citation?: {
          url?: string;
        };
      }>;
    };
  }>;
  citations?: string[];
};

type PerplexitySearchApiResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    date?: string;
  }>;
};

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): PerplexityAuth {
  const fromConfig = readConfiguredSecretString(
    perplexity?.apiKey,
    "plugins.entries.perplexity.config.webSearch.apiKey",
  );
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }
  const fromPerplexityEnv = readProviderEnvValue(["PERPLEXITY_API_KEY"]);
  if (fromPerplexityEnv) {
    return { apiKey: fromPerplexityEnv, source: "perplexity_env" };
  }
  const fromOpenRouterEnv = readProviderEnvValue(["OPENROUTER_API_KEY"]);
  if (fromOpenRouterEnv) {
    return { apiKey: fromOpenRouterEnv, source: "openrouter_env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function extractPerplexityCitations(data: PerplexitySearchResponse): string[] {
  const topLevel = (data.citations ?? []).filter((url): url is string =>
    Boolean(normalizeOptionalString(url)),
  );
  if (topLevel.length > 0) {
    return uniqueStrings(topLevel);
  }
  const citations: string[] = [];
  for (const choice of data.choices ?? []) {
    for (const annotation of choice.message?.annotations ?? []) {
      if (annotation.type !== "url_citation") {
        continue;
      }
      const url =
        typeof annotation.url_citation?.url === "string"
          ? annotation.url_citation.url
          : annotation.url;
      const normalizedUrl = normalizeOptionalString(url);
      if (normalizedUrl) {
        citations.push(normalizedUrl);
      }
    }
  }
  return uniqueStrings(citations);
}

export async function executePerplexitySearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const perplexityConfig = resolvePerplexityConfig(searchConfig);
  const runtime = resolvePerplexityRuntime(
    perplexityConfig,
    resolvePerplexityApiKey(perplexityConfig),
  );
  if (!runtime.apiKey) {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure plugins.entries.perplexity.config.webSearch.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const { query, count } = readWebSearchQueryAndCount(args, searchConfig);
  const rawFreshness = readStringParam(args, "freshness");
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "perplexity") : undefined;
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const structured = runtime.transport === "search_api";
  const country = readStringParam(args, "country");
  const language = readStringParam(args, "language");
  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  const domainFilter = readStringArrayParam(args, "domain_filter");
  const maxTokens = readPositiveIntegerParam(args, "max_tokens", {
    max: 1_000_000,
    message: "max_tokens must be a positive integer.",
  });
  const maxTokensPerPage = readPositiveIntegerParam(args, "max_tokens_per_page", {
    message: "max_tokens_per_page must be a positive integer.",
  });

  if (!structured) {
    const unsupportedOptions = [
      [country, "unsupported_country", "country filtering", "it"],
      [language, "unsupported_language", "language filtering", "it"],
      [rawDateAfter || rawDateBefore, "unsupported_date_filter", "date_after/date_before", "them"],
      [domainFilter?.length, "unsupported_domain_filter", "domain_filter", "it"],
      [
        maxTokens !== undefined || maxTokensPerPage !== undefined,
        "unsupported_content_budget",
        "max_tokens and max_tokens_per_page",
        "them",
      ],
    ] as const;
    for (const [value, error, option, pronoun] of unsupportedOptions) {
      if (value) {
        return {
          error,
          message: `${option} ${pronoun === "them" ? "are" : "is"} only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable ${pronoun}.`,
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
    }
  }

  if (language && !/^[a-z]{2}$/iu.test(language)) {
    return {
      error: "invalid_language",
      message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const parsedTimeFilters = parseWebSearchTimeFilters({
    rawFreshness,
    rawDateAfter,
    rawDateBefore,
    freshnessProvider: "perplexity",
    invalidFreshnessMessage: "freshness must be day, week, month, or year.",
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedTimeFilters) {
    return parsedTimeFilters;
  }
  const { dateAfter, dateBefore } = parsedTimeFilters;
  if (domainFilter?.length) {
    const hasDeny = domainFilter.some((entry) => entry.startsWith("-"));
    const hasAllow = domainFilter.some((entry) => !entry.startsWith("-"));
    if (hasDeny && hasAllow) {
      return {
        error: "invalid_domain_filter",
        message:
          "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries (allowlist) or all entries prefixed with '-' (denylist).",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (domainFilter.length > 20) {
      return {
        error: "invalid_domain_filter",
        message: "domain_filter supports a maximum of 20 domains.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
  }

  const cacheKey = buildSearchCacheKey([
    "perplexity",
    runtime.transport,
    runtime.baseUrl,
    runtime.model,
    query,
    structured ? resolveSearchCount(count, DEFAULT_SEARCH_COUNT) : undefined,
    country,
    language,
    freshness,
    dateAfter,
    dateBefore,
    domainFilter?.join(","),
    maxTokens,
    maxTokensPerPage,
  ]);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const searchCount = structured ? resolveSearchCount(count, DEFAULT_SEARCH_COUNT) : 0;
  const searchLanguageFilter = language ? [language] : undefined;
  const searchAfterDate = structured && dateAfter ? isoToPerplexityDate(dateAfter) : undefined;
  const searchBeforeDate = structured && dateBefore ? isoToPerplexityDate(dateBefore) : undefined;
  const label = structured ? "Perplexity Search" : "Perplexity";
  const endpoint = structured
    ? PERPLEXITY_SEARCH_ENDPOINT
    : `${runtime.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
  const body = structured
    ? {
        query,
        max_results: searchCount,
        ...(country ? { country } : {}),
        ...(domainFilter?.length ? { search_domain_filter: domainFilter } : {}),
        ...(freshness ? { search_recency_filter: freshness } : {}),
        ...(searchLanguageFilter?.length ? { search_language_filter: searchLanguageFilter } : {}),
        ...(searchAfterDate ? { search_after_date_filter: searchAfterDate } : {}),
        ...(searchBeforeDate ? { search_before_date_filter: searchBeforeDate } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        ...(maxTokensPerPage !== undefined ? { max_tokens_per_page: maxTokensPerPage } : {}),
      }
    : {
        model: resolvePerplexityRequestModel(runtime.baseUrl, runtime.model),
        messages: [{ role: "user", content: query }],
        ...(freshness ? { search_recency_filter: freshness } : {}),
      };
  const defaultHeaders = {
    "Content-Type": "application/json",
    ...(structured ? { Accept: "application/json" } : {}),
    Authorization: `Bearer ${runtime.apiKey}`,
  };
  const headers =
    resolveProviderRequestHeaders({
      provider: "perplexity",
      // The direct Perplexity API is this provider's default endpoint. Other hosts such as
      // OpenRouter keep their own endpoint so the policy attributes them as that vendor.
      baseUrl:
        !structured && !isDirectPerplexityBaseUrl(runtime.baseUrl) ? runtime.baseUrl : undefined,
      capability: "other",
      transport: "http",
      defaultHeaders,
    }) ?? defaultHeaders;
  const result = await withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      signal,
      init: { method: "POST", headers, body: JSON.stringify(body) },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, label, { headers, signal });
      }
      if (structured) {
        const data = await readProviderJsonResponse<PerplexitySearchApiResponse>(res, label);
        return (data.results ?? []).slice(0, searchCount).map((entry) => ({
          title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
          url: entry.url ?? "",
          description: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
          published: entry.date ?? undefined,
          siteName: resolveSiteName(entry.url) || undefined,
        }));
      }
      const data = await readProviderJsonResponse<PerplexitySearchResponse>(res, label);
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error(
          "Perplexity search returned no final answer. Retry the query or choose another search provider.",
        );
      }
      return { content, citations: extractPerplexityCitations(data) };
    },
  );
  const resultFields = Array.isArray(result)
    ? { results: result }
    : {
        content: wrapWebContent(result.content, "web_search"),
        citations: result.citations,
      };
  const payload = {
    query,
    provider: "perplexity",
    ...(Array.isArray(result) ? { count: result.length } : { model: runtime.model }),
    tookMs: Date.now() - start,
    externalContent: externalContentStamp("perplexity"),
    ...resultFields,
  };

  signal?.throwIfAborted();
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
