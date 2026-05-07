import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  markdownToText,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  truncateText,
  withStrictWebToolsEndpoint,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import { SsrFBlockedError, isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  DEFAULT_TINYFISH_BASE_URL,
  resolveTinyFishApiKey,
  resolveTinyFishBaseUrl,
  resolveTinyFishFetchTimeoutSeconds,
  resolveTinyFishSearchTimeoutSeconds,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const FETCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_FETCH_MAX_CHARS = 50_000;
const CLIENT_SOURCE = "openclaw";

type TinyFishSearchItem = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
};

export type TinyFishSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  count?: number;
  timeoutSeconds?: number;
};

export type TinyFishFetchParams = {
  cfg?: OpenClawConfig;
  url: string;
  extractMode: "markdown" | "text";
  maxChars?: number;
  timeoutSeconds?: number;
};

export function assertTinyFishFetchTargetAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrFBlockedError("Invalid URL supplied to TinyFish fetch");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrFBlockedError(
      `Blocked non-HTTP(S) protocol in TinyFish fetch URL: ${parsed.protocol}`,
    );
  }
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    throw new SsrFBlockedError(
      `Blocked hostname or private/internal IP in TinyFish fetch URL: ${parsed.hostname}`,
    );
  }
}

function resolveSearchEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.trim() || DEFAULT_TINYFISH_BASE_URL);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = "/v1/search";
  return url.toString();
}

function resolveFetchEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl.trim() || DEFAULT_TINYFISH_BASE_URL);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = "/v1/fetch";
  return url.toString();
}

function resolveSiteName(urlRaw: string): string | undefined {
  try {
    const host = new URL(urlRaw).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function resolveSearchItems(payload: Record<string, unknown>): TinyFishSearchItem[] {
  const rawItems = payload.results;
  if (!Array.isArray(rawItems)) {
    return [];
  }
  const items: TinyFishSearchItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    if (!url) {
      continue;
    }
    const title = typeof record.title === "string" ? record.title : "";
    const snippet = typeof record.snippet === "string" ? record.snippet : "";
    items.push({
      title,
      url,
      snippet,
      siteName: resolveSiteName(url),
    });
  }
  return items;
}

function buildSearchPayload(params: {
  query: string;
  items: TinyFishSearchItem[];
  tookMs: number;
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: "tinyfish",
    count: params.items.length,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "tinyfish",
      wrapped: true,
    },
    results: params.items.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url,
      description: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
      ...(entry.siteName ? { siteName: entry.siteName } : {}),
    })),
  };
}

export async function runTinyFishSearch(
  params: TinyFishSearchParams,
): Promise<Record<string, unknown>> {
  const apiKey = resolveTinyFishApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_search (tinyfish) needs a TinyFish API key. Set TINYFISH_API_KEY in the Gateway environment, or configure plugins.entries.tinyfish.config.webSearch.apiKey.",
    );
  }
  const count =
    typeof params.count === "number" && Number.isFinite(params.count)
      ? Math.max(1, Math.min(10, Math.floor(params.count)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveTinyFishSearchTimeoutSeconds(params.timeoutSeconds);
  const baseUrl = resolveTinyFishBaseUrl(params.cfg);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "tinyfish-search",
      q: params.query,
      count,
      baseUrl,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const endpoint = resolveSearchEndpoint(baseUrl);
  const result = await withStrictWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": normalizeSecretInput(apiKey) ?? "",
          "X-Client-Source": CLIENT_SOURCE,
        },
        body: JSON.stringify({
          query: params.query,
          num_results: count,
        }),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const errorBody = await readResponseText(response, { maxBytes: 2_048 });
        const safeDetail = wrapWebContent(
          (errorBody.text || response.statusText || "request failed").slice(0, 1_000),
          "web_search",
        );
        throw new Error(`TinyFish Search API error (${response.status}): ${safeDetail}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      return buildSearchPayload({
        query: params.query,
        items: resolveSearchItems(payload),
        tookMs: Date.now() - start,
      });
    },
  );

  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export function parseTinyFishFetchPayload(params: {
  payload: Record<string, unknown>;
  url: string;
  extractMode: "markdown" | "text";
  maxChars: number;
}): Record<string, unknown> {
  const results = params.payload.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("TinyFish fetch returned no content.");
  }
  const data = results[0] as Record<string, unknown>;
  const rawText = typeof data.text === "string" ? data.text : "";
  if (!rawText) {
    throw new Error("TinyFish fetch returned no content.");
  }
  const text = params.extractMode === "text" ? markdownToText(rawText) : rawText;
  const truncated = truncateText(text, params.maxChars);
  return {
    url: params.url,
    finalUrl: (typeof data.final_url === "string" && data.final_url) || params.url,
    title:
      typeof data.title === "string" && data.title
        ? wrapExternalContent(data.title, { source: "web_fetch", includeWarning: false })
        : undefined,
    extractor: "tinyfish",
    extractMode: params.extractMode,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: truncated.truncated,
    rawLength: text.length,
    wrappedLength: wrapExternalContent(truncated.text, {
      source: "web_fetch",
      includeWarning: false,
    }).length,
    text: wrapExternalContent(truncated.text, {
      source: "web_fetch",
      includeWarning: false,
    }),
  };
}

export async function runTinyFishFetch(
  params: TinyFishFetchParams,
): Promise<Record<string, unknown>> {
  assertTinyFishFetchTargetAllowed(params.url);

  const apiKey = resolveTinyFishApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_fetch (tinyfish) needs a TinyFish API key. Set TINYFISH_API_KEY in the Gateway environment, or configure plugins.entries.tinyfish.config.webFetch.apiKey.",
    );
  }
  const baseUrl = resolveTinyFishBaseUrl(params.cfg);
  const timeoutSeconds = resolveTinyFishFetchTimeoutSeconds(params.timeoutSeconds);
  const maxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : DEFAULT_FETCH_MAX_CHARS;
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "tinyfish-fetch",
      url: params.url,
      extractMode: params.extractMode,
      baseUrl,
      maxChars,
    }),
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const endpoint = resolveFetchEndpoint(baseUrl);
  const format = params.extractMode === "text" ? "text" : "markdown";
  const result = await withStrictWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": normalizeSecretInput(apiKey) ?? "",
          "X-Client-Source": CLIENT_SOURCE,
        },
        body: JSON.stringify({
          url: params.url,
          format,
        }),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const errorBody = await readResponseText(response, { maxBytes: 2_048 });
        const safeDetail = wrapWebContent(
          (errorBody.text || response.statusText || "request failed").slice(0, 1_000),
          "web_fetch",
        );
        throw new Error(`TinyFish fetch failed (${response.status}): ${safeDetail}`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      return parseTinyFishFetchPayload({
        payload,
        url: params.url,
        extractMode: params.extractMode,
        maxChars,
      });
    },
  );

  writeCache(
    FETCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export const __testing = {
  assertTinyFishFetchTargetAllowed,
  parseTinyFishFetchPayload,
  resolveSearchItems,
};
