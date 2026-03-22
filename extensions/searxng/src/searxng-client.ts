import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  resolveCacheTtlMs,
  withWebToolsNetworkGuard,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  DEFAULT_SEARXNG_BASE_URL,
  resolveSearXNGApiKey,
  resolveSearXNGBaseUrl,
  resolveSearXNGAllowPrivateNetwork,
  resolveSearXNGTimeoutSeconds,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;

export type SearXNGSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  count?: number;
  timeRange?: string;
  language?: string;
  timeoutSeconds?: number;
};

export async function runSearXNGSearch(
  params: SearXNGSearchParams,
): Promise<Record<string, unknown>> {
  const apiKey = resolveSearXNGApiKey(params.cfg);
  const baseUrl = resolveSearXNGBaseUrl(params.cfg);
  const timeoutSeconds = resolveSearXNGTimeoutSeconds(params.timeoutSeconds);
  const count = params.count ?? DEFAULT_SEARCH_COUNT;

  const allowPrivateNetwork = resolveSearXNGAllowPrivateNetwork(params.cfg);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "searxng-search",
      q: params.query,
      num: count,
      baseUrl,
      timeRange: params.timeRange,
      language: params.language,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const endpoint = (() => {
    try {
      const url = new URL(baseUrl);
      url.pathname = url.pathname.replace(/\/$/, "") + "/search";
      return url.toString();
    } catch {
      return new URL("/search", DEFAULT_SEARXNG_BASE_URL).toString();
    }
  })();

  const queryParams = new URLSearchParams();
  queryParams.set("q", params.query);
  queryParams.set("format", "json");
  queryParams.set("num", String(count));
  if (params.timeRange) {
    queryParams.set("time_range", params.timeRange);
  }
  if (params.language) {
    queryParams.set("language", params.language);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "OpenClaw/SearXNG-Plugin",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const start = Date.now();
  const payload = await withWebToolsNetworkGuard(
    {
      url: `${endpoint}?${queryParams.toString()}`,
      init: {
        method: "GET",
        headers,
      },
      timeoutSeconds,
      policy: {
        dangerouslyAllowPrivateNetwork: allowPrivateNetwork,
      },
    },
    async ({ response }: { response: Response }) => {
      if (!response.ok) {
        throw new Error(`SearXNG Search failed: ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as Record<string, unknown>;
    },
  );
  const rawResults = Array.isArray(payload.results) ? payload.results : [];
  const results = rawResults.map((r: Record<string, unknown>) => ({
    title: typeof r.title === "string" ? wrapWebContent(r.title, "web_search") : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.content === "string" ? wrapWebContent(r.content, "web_search") : "",
    score: typeof r.score === "number" ? r.score : undefined,
    siteName: typeof r.engine === "string" ? r.engine : undefined,
  }));

  const result: Record<string, unknown> = {
    query: params.query,
    provider: "searxng",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "searxng",
      wrapped: true,
    },
    results,
  };

  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}
