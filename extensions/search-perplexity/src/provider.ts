import {
  buildSearchRequestCacheIdentity,
  createLegacySearchProviderMetadata,
  createMissingSearchKeyPayload,
  createSearchProviderErrorResult,
  normalizeCacheKey,
  normalizeDateInputToIso,
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
  readCache,
  resolveSearchConfig,
  resolveSearchProviderSectionConfig,
  resolveSiteName,
  throwWebSearchApiError,
  type OpenClawConfig,
  type SearchProviderExecutionResult,
  type SearchProviderLegacyUiMetadata,
  type SearchProviderPlugin,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/web-search";

const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];
const PERPLEXITY_RECENCY_VALUES = new Set(["day", "week", "month", "year"]);
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const PERPLEXITY_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number }
>();

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";
type PerplexityTransport = "search_api" | "chat_completions";
type PerplexityBaseUrlHint = "direct" | "openrouter";

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

type PerplexitySearchApiResult = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
};

type PerplexitySearchApiResponse = {
  results?: PerplexitySearchApiResult[];
};

function normalizeApiKey(key: unknown): string {
  return normalizeSecretInput(key);
}

function extractPerplexityCitations(data: PerplexitySearchResponse): string[] {
  const normalizeUrl = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  const topLevel = (data.citations ?? [])
    .map(normalizeUrl)
    .filter((url): url is string => Boolean(url));
  if (topLevel.length > 0) {
    return [...new Set(topLevel)];
  }
  const citations: string[] = [];
  for (const choice of data.choices ?? []) {
    for (const annotation of choice.message?.annotations ?? []) {
      if (annotation.type !== "url_citation") {
        continue;
      }
      const url = normalizeUrl(annotation.url_citation?.url ?? annotation.url);
      if (url) {
        citations.push(url);
      }
    }
  }
  return [...new Set(citations)];
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  return resolveSearchProviderSectionConfig<PerplexityConfig>(
    search as Record<string, unknown> | undefined,
    "perplexity",
  );
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }
  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }
  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }
  return { apiKey: undefined, source: "none" };
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  authSource: PerplexityApiKeySource = "none",
  configuredKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (authSource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (authSource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (authSource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(configuredKey);
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function isDirectPerplexityBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return false;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase() === "api.perplexity.ai";
  } catch {
    return false;
  }
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function resolvePerplexityTransport(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
  baseUrl: string;
  model: string;
  transport: PerplexityTransport;
} {
  const auth = resolvePerplexityApiKey(perplexity);
  const baseUrl = resolvePerplexityBaseUrl(perplexity, auth.source, auth.apiKey);
  const model = resolvePerplexityModel(perplexity);
  const hasLegacyOverride = Boolean(
    (perplexity?.baseUrl && perplexity.baseUrl.trim()) ||
    (perplexity?.model && perplexity.model.trim()),
  );
  return {
    ...auth,
    baseUrl,
    model,
    transport:
      hasLegacyOverride || !isDirectPerplexityBaseUrl(baseUrl) ? "chat_completions" : "search_api",
  };
}

async function runPerplexitySearchApi(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  searchDomainFilter?: string[];
  searchRecencyFilter?: string;
  searchLanguageFilter?: string[];
  searchAfterDate?: string;
  searchBeforeDate?: string;
  maxTokens?: number;
  maxTokensPerPage?: number;
}) {
  const body: Record<string, unknown> = { query: params.query, max_results: params.count };
  if (params.country) body.country = params.country;
  if (params.searchDomainFilter?.length) body.search_domain_filter = params.searchDomainFilter;
  if (params.searchRecencyFilter) body.search_recency_filter = params.searchRecencyFilter;
  if (params.searchLanguageFilter?.length)
    body.search_language_filter = params.searchLanguageFilter;
  if (params.searchAfterDate) body.search_after_date = params.searchAfterDate;
  if (params.searchBeforeDate) body.search_before_date = params.searchBeforeDate;
  if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
  if (params.maxTokensPerPage !== undefined) body.max_tokens_per_page = params.maxTokensPerPage;

  return withTrustedWebToolsEndpoint(
    {
      url: PERPLEXITY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        body: JSON.stringify(body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwWebSearchApiError(response, "Perplexity Search");
      }
      const data = (await response.json()) as PerplexitySearchApiResponse;
      const results = Array.isArray(data.results) ? data.results : [];
      return results.map((entry) => {
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const snippet = entry.snippet ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: snippet ? wrapWebContent(snippet, "web_search") : "",
          published: entry.date ?? undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}) {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: params.query }],
  };
  if (params.freshness) {
    body.search_recency_filter = params.freshness;
  }
  return withTrustedWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "HTTP-Referer": "https://openclaw.ai",
          "X-Title": "OpenClaw Web Search",
        },
        body: JSON.stringify(body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwWebSearchApiError(response, "Perplexity");
      }
      const data = (await response.json()) as PerplexitySearchResponse;
      return {
        content: data.choices?.[0]?.message?.content ?? "No response",
        citations: extractPerplexityCitations(data),
      };
    },
  );
}

function isoToPerplexityDate(iso: string): string | undefined {
  const match = iso.match(ISO_DATE_PATTERN);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}/${year}`;
}

function createPerplexityPayload(params: {
  request: { query: string };
  startedAt: number;
  model?: string;
  results?: unknown[];
  content?: string;
  citations?: string[];
}) {
  const payload: Record<string, unknown> = {
    query: params.request.query,
    provider: "perplexity",
    tookMs: Date.now() - params.startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "perplexity",
      wrapped: true,
    },
  };
  if (params.model) payload.model = params.model;
  if (params.results) {
    payload.results = params.results;
    payload.count = params.results.length;
  }
  if (params.content) payload.content = wrapWebContent(params.content, "web_search");
  if (params.citations) payload.citations = params.citations;
  return payload;
}

export const PERPLEXITY_SEARCH_PROVIDER_METADATA: SearchProviderLegacyUiMetadata =
  createLegacySearchProviderMetadata({
    provider: "perplexity",
    label: "Perplexity Search",
    hint: "Structured results · domain/country/language/time filters",
    envKeys: ["PERPLEXITY_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    apiKeyConfigPath: "tools.web.search.perplexity.apiKey",
    resolveRuntimeMetadata: (params) => ({
      perplexityTransport: resolvePerplexityTransport(
        resolvePerplexityConfig(resolveSearchConfig<WebSearchConfig>(params.search)),
      ).transport,
    }),
  });

export function createBundledPerplexitySearchProvider(): SearchProviderPlugin {
  return {
    id: "perplexity",
    name: "Perplexity",
    description:
      "Search the web using Perplexity. Runtime routing decides between native Search API and Sonar chat-completions compatibility. Structured filters are available on the native Search API path.",
    pluginOwnedExecution: true,
    legacyConfig: PERPLEXITY_SEARCH_PROVIDER_METADATA,
    resolveRuntimeMetadata: PERPLEXITY_SEARCH_PROVIDER_METADATA.resolveRuntimeMetadata,
    isAvailable: (config) =>
      Boolean(
        resolvePerplexityApiKey(
          resolvePerplexityConfig(
            resolveSearchConfig<WebSearchConfig>(
              config?.tools?.web?.search as Record<string, unknown>,
            ),
          ),
        ).apiKey,
      ),
    search: async (request, ctx): Promise<SearchProviderExecutionResult> => {
      const search = resolveSearchConfig<WebSearchConfig>(request.providerConfig);
      const runtime = resolvePerplexityTransport(resolvePerplexityConfig(search));
      if (!runtime.apiKey) {
        return createMissingSearchKeyPayload(
          "missing_perplexity_api_key",
          "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
        );
      }
      const supportsStructured = runtime.transport === "search_api";
      if (request.country && !supportsStructured) {
        return createSearchProviderErrorResult(
          "unsupported_country",
          "country filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
        );
      }
      if (request.language && !supportsStructured) {
        return createSearchProviderErrorResult(
          "unsupported_language",
          "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
        );
      }
      if (request.language && !/^[a-z]{2}$/i.test(request.language)) {
        return createSearchProviderErrorResult(
          "invalid_language",
          "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
        );
      }
      const normalizedFreshness = request.freshness
        ? PERPLEXITY_RECENCY_VALUES.has(request.freshness.trim().toLowerCase())
          ? request.freshness.trim().toLowerCase()
          : undefined
        : undefined;
      if (request.freshness && !normalizedFreshness) {
        return createSearchProviderErrorResult(
          "invalid_freshness",
          "freshness must be day, week, month, or year.",
        );
      }
      if ((request.dateAfter || request.dateBefore) && !supportsStructured) {
        return createSearchProviderErrorResult(
          "unsupported_date_filter",
          "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
        );
      }
      if (request.domainFilter && request.domainFilter.length > 0 && !supportsStructured) {
        return createSearchProviderErrorResult(
          "unsupported_domain_filter",
          "domain_filter is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
        );
      }
      if (request.domainFilter && request.domainFilter.length > 0) {
        const hasDenylist = request.domainFilter.some((domain) => domain.startsWith("-"));
        const hasAllowlist = request.domainFilter.some((domain) => !domain.startsWith("-"));
        if (hasDenylist && hasAllowlist) {
          return createSearchProviderErrorResult(
            "invalid_domain_filter",
            "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries (allowlist) or all entries prefixed with '-' (denylist).",
          );
        }
        if (request.domainFilter.length > 20) {
          return createSearchProviderErrorResult(
            "invalid_domain_filter",
            "domain_filter supports a maximum of 20 domains.",
          );
        }
      }
      if (
        runtime.transport === "chat_completions" &&
        (request.maxTokens !== undefined || request.maxTokensPerPage !== undefined)
      ) {
        return createSearchProviderErrorResult(
          "unsupported_content_budget",
          "max_tokens and max_tokens_per_page are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
        );
      }
      if (request.dateAfter && !normalizeDateInputToIso(request.dateAfter)) {
        return createSearchProviderErrorResult(
          "invalid_date_after",
          "date_after must be a valid YYYY-MM-DD date.",
        );
      }
      if (request.dateBefore && !normalizeDateInputToIso(request.dateBefore)) {
        return createSearchProviderErrorResult(
          "invalid_date_before",
          "date_before must be a valid YYYY-MM-DD date.",
        );
      }

      const cacheKey = normalizeCacheKey(
        `perplexity:${runtime.transport}:${runtime.baseUrl}:${runtime.model}:${buildSearchRequestCacheIdentity(
          {
            query: request.query,
            count: request.count,
            country: request.country,
            language: request.language,
            freshness: normalizedFreshness,
            dateAfter: request.dateAfter,
            dateBefore: request.dateBefore,
            domainFilter: request.domainFilter,
            maxTokens: request.maxTokens,
            maxTokensPerPage: request.maxTokensPerPage,
          },
        )}`,
      );
      const cached = readCache(PERPLEXITY_SEARCH_CACHE, cacheKey);
      if (cached) return { ...cached.value, cached: true } as SearchProviderExecutionResult;
      const startedAt = Date.now();
      let payload: Record<string, unknown>;
      if (runtime.transport === "chat_completions") {
        const result = await runPerplexitySearch({
          query: request.query,
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          model: runtime.model,
          timeoutSeconds: ctx.timeoutSeconds,
          freshness: normalizedFreshness,
        });
        payload = createPerplexityPayload({
          request,
          startedAt,
          model: runtime.model,
          content: result.content,
          citations: result.citations,
        });
      } else {
        const results = await runPerplexitySearchApi({
          query: request.query,
          apiKey: runtime.apiKey,
          count: request.count,
          timeoutSeconds: ctx.timeoutSeconds,
          country: request.country,
          searchDomainFilter: request.domainFilter,
          searchRecencyFilter: normalizedFreshness,
          searchLanguageFilter: request.language ? [request.language] : undefined,
          searchAfterDate: request.dateAfter ? isoToPerplexityDate(request.dateAfter) : undefined,
          searchBeforeDate: request.dateBefore
            ? isoToPerplexityDate(request.dateBefore)
            : undefined,
          maxTokens: request.maxTokens,
          maxTokensPerPage: request.maxTokensPerPage,
        });
        payload = createPerplexityPayload({ request, startedAt, results });
      }
      writeCache(PERPLEXITY_SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
      return payload as SearchProviderExecutionResult;
    },
  };
}

export const __testing = {
  PERPLEXITY_SEARCH_CACHE,
  clearSearchProviderCaches() {
    PERPLEXITY_SEARCH_CACHE.clear();
  },
} as const;
