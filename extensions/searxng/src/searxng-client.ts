import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_TIMEOUT_SECONDS,
  resolveInstances,
  resolveLanguage,
  resolveSafeSearch,
} from "./config.js";

export type SearxngSearchParams = {
  cfg?: { plugins?: { entries?: Record<string, { config?: unknown }> } };
  query: string;
  maxResults?: number;
  language?: string;
};

type SearxngResult = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
};

type SearxngJsonResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
};

type SearxngJsonResponse = {
  results?: SearxngJsonResult[];
  query?: string;
};

// Module-level cache: key → { value, expiresAt }
const SEARCH_CACHE = new Map<string, { value: Record<string, unknown>; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function resolveSiteName(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function buildSearchUrl(base: string, params: SearxngSearchParams, language: string, safeSearch: string): string {
  const url = new URL("/search", base);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  url.searchParams.set("language", params.language ?? language);
  url.searchParams.set("safesearch", safeSearch);
  return url.toString();
}

async function tryInstance(
  base: string,
  params: SearxngSearchParams,
  language: string,
  safeSearch: string,
  count: number,
  timeoutMs: number,
): Promise<SearxngResult[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = buildSearchUrl(base, params, language, safeSearch);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Language": language,
      },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    // SearXNG returns JSON; if the instance returns HTML it's misconfigured
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return null;

    const data = (await response.json()) as SearxngJsonResponse;
    if (!Array.isArray(data.results)) return null;

    return data.results.slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
      siteName: r.url ? resolveSiteName(r.url) : undefined,
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function runSearxngSearch(
  params: SearxngSearchParams,
): Promise<Record<string, unknown>> {
  const count =
    typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
      ? Math.max(1, Math.min(25, Math.floor(params.maxResults)))
      : DEFAULT_MAX_RESULTS;
  const language = params.language ?? resolveLanguage(params.cfg);
  const safeSearch = resolveSafeSearch(params.cfg);
  const instances = resolveInstances(params.cfg);
  const timeoutMs = DEFAULT_TIMEOUT_SECONDS * 1000;

  const cacheKey = JSON.stringify({ q: params.query, count, language, safeSearch });
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  let lastError = "";

  for (const base of instances) {
    const results = await tryInstance(base, params, language, safeSearch, count, timeoutMs);
    if (results !== null) {
      const value: Record<string, unknown> = {
        query: params.query,
        provider: "searxng",
        instance: base,
        count: results.length,
        tookMs: Date.now() - start,
        results,
      };
      SEARCH_CACHE.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    }
    lastError = `instance ${base} failed`;
  }

  throw new Error(
    `All SearXNG instances failed (tried ${instances.length}). Last error: ${lastError}. ` +
      "Consider running a local instance: docker run -d -p 8080:8080 searxng/searxng",
  );
}

export const __testing = { SEARCH_CACHE, buildSearchUrl };
