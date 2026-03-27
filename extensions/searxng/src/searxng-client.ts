import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  resolveSiteName,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  DEFAULT_SEARXNG_BASE_URL,
  DEFAULT_SEARXNG_COUNT,
  MAX_SEARXNG_COUNT,
  resolveSearXNGBaseUrl,
  resolveSearXNGCategories,
  resolveSearXNGCount,
  resolveSearXNGLang,
} from "./config.js";

type SearXNGResult = {
  title?: string;
  url?: string;
  description?: string;
  published?: string;
};

type SearXNGResponse = {
  results?: SearXNGResult[];
};

const SEARXNG_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

function clampCount(value: number | undefined, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(MAX_SEARXNG_COUNT, Math.floor(n)));
}

export async function runSearXNGSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  lang?: string;
  categories?: string[];
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const baseUrl = resolveSearXNGBaseUrl(params.config).replace(/\/$/, "");
  const count = clampCount(
    params.count ?? resolveSearXNGCount(params.config),
    DEFAULT_SEARXNG_COUNT,
  );
  const lang = params.lang ?? resolveSearXNGLang(params.config);
  const categories = params.categories ?? resolveSearXNGCategories(params.config);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "searxng",
      baseUrl,
      query: params.query,
      count,
      lang,
      categories: categories ?? [],
    }),
  );
  const cached = readCache(SEARXNG_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const searchParams = new URLSearchParams({
    q: params.query,
    format: "json",
    results_per_page: String(count),
    language: lang,
  });
  if (categories && categories.length > 0) {
    searchParams.set("categories", categories.join(","));
  }

  const url = `${baseUrl}/search?${searchParams.toString()}`;
  const startedAt = Date.now();

  const results = await withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds,
      init: {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(
          `SearXNG search error (${response.status}): ${detail || response.statusText}`,
        );
      }
      const data = (await response.json()) as SearXNGResponse;
      return Array.isArray(data.results) ? data.results : [];
    },
  );

  const payload = {
    query: params.query,
    provider: "searxng",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "searxng",
      wrapped: true,
    },
    results: results.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url ?? "",
      description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
      published: entry.published || undefined,
      siteName: entry.url ? resolveSiteName(entry.url) || undefined : undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(SEARXNG_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}
