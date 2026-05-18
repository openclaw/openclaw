import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  postTrustedWebToolsJson,
  readCache,
  resolveCacheTtlMs,
  resolveSiteName,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import { resolveComposioApiKey } from "./config.js";

const COMPOSIO_SEARCH_ENDPOINT =
  "https://backend.composio.dev/api/v3/tools/execute/COMPOSIO_SEARCH_SEARCH";
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

type ComposioSearchResult = {
  title?: string;
  link?: string;
  snippet?: string;
};

type ComposioSearchResponse = {
  data?: {
    results?: {
      organic_results?: ComposioSearchResult[];
    };
  };
  error?: string | null;
  successful?: boolean;
};

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();

function resolveSearchCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(value)))
    : DEFAULT_SEARCH_COUNT;
}

function normalizeComposioSearchResult(result: ComposioSearchResult): {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
} {
  const url = result.link ?? "";
  return {
    title: result.title ?? "",
    url,
    snippet: result.snippet ?? "",
    siteName: resolveSiteName(url) || undefined,
  };
}

function readComposioResults(payload: ComposioSearchResponse): ComposioSearchResult[] {
  if (payload.successful === false) {
    throw new Error(`Composio Search failed: ${payload.error || "unknown error"}`);
  }
  const results = payload.data?.results?.organic_results;
  return Array.isArray(results) ? results : [];
}

export async function runComposioSearch(params: {
  cfg?: OpenClawConfig;
  query: string;
  count?: number;
}): Promise<Record<string, unknown>> {
  const apiKey = resolveComposioApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_search (composio) needs a Composio API key. Set COMPOSIO_API_KEY in the Gateway environment, or configure plugins.entries.composio.config.webSearch.apiKey.",
    );
  }

  const count = resolveSearchCount(params.count);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({ type: "composio-search", q: params.query, count }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const response = await postTrustedWebToolsJson(
    {
      url: COMPOSIO_SEARCH_ENDPOINT,
      timeoutSeconds: 30,
      apiKey,
      body: {
        arguments: {
          query: params.query,
          num_results: count,
        },
      },
      errorLabel: "Composio Search",
      extraHeaders: { "x-api-key": apiKey },
    },
    async (res) => (await res.json()) as Record<string, unknown>,
  );
  const results = readComposioResults(response as ComposioSearchResponse).map(
    normalizeComposioSearchResult,
  );
  const payload: Record<string, unknown> = {
    query: params.query,
    provider: "composio",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "composio",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: result.title ? wrapWebContent(result.title, "web_search") : "",
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: result.siteName,
    })),
  };
  writeCache(
    SEARCH_CACHE,
    cacheKey,
    payload,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return payload;
}

export const __testing = {
  normalizeComposioSearchResult,
  readComposioResults,
  resolveSearchCount,
};
