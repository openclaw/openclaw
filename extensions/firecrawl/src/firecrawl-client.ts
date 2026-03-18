import { markdownToText, truncateText } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { withTrustedWebToolsEndpoint } from "openclaw/plugin-sdk/provider-web-search";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
  resolveFirecrawlMaxAgeMs,
  resolveFirecrawlOnlyMainContent,
  resolveFirecrawlScrapeTimeoutSeconds,
  resolveFirecrawlSearchTimeoutSeconds,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const SCRAPE_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;
const DEFAULT_SCRAPE_MAX_CHARS = 50_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;

type FirecrawlSearchItem = {
  title: string;
  url: string;
  description?: string;
  content?: string;
  published?: string;
  siteName?: string;
};

export type FirecrawlSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  count?: number;
  timeoutSeconds?: number;
  sources?: string[];
  categories?: string[];
  scrapeResults?: boolean;
};

export type FirecrawlScrapeParams = {
  cfg?: OpenClawConfig;
  url: string;
  extractMode: "markdown" | "text";
  maxChars?: number;
  onlyMainContent?: boolean;
  maxAgeMs?: number;
  proxy?: "auto" | "basic" | "stealth";
  storeInCache?: boolean;
  timeoutSeconds?: number;
};

function resolveEndpoint(baseUrl: string, pathname: "/v2/search" | "/v2/scrape"): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return new URL(pathname, "https://api.firecrawl.dev").toString();
  }
  try {
    const url = new URL(trimmed);
    if (url.pathname && url.pathname !== "/") {
      return url.toString();
    }
    url.pathname = pathname;
    return url.toString();
  } catch {
    return new URL(pathname, "https://api.firecrawl.dev").toString();
  }
}

function resolveSiteName(urlRaw: string): string | undefined {
  try {
    const host = new URL(urlRaw).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

async function postFirecrawlJson(params: {
  baseUrl: string;
  pathname: "/v2/search" | "/v2/scrape";
  apiKey: string;
  body: Record<string, unknown>;
  timeoutSeconds: number;
  errorLabel: string;
}): Promise<Record<string, unknown>> {
  const endpoint = resolveEndpoint(params.baseUrl, params.pathname);
  return await withTrustedWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, { maxBytes: DEFAULT_ERROR_MAX_BYTES });
        throw new Error(
          `${params.errorLabel} API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      const payload = (await response.json()) as Record<string, unknown>;
      if (payload.success === false) {
        const error =
          typeof payload.error === "string"
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : "unknown error";
        throw new Error(`${params.errorLabel} API error: ${error}`);
      }
      return payload;
    },
  );
}

function resolveSearchItems(payload: Record<string, unknown>): FirecrawlSearchItem[] {
  const candidates = [
    payload.data,
    payload.results,
    (payload.data as { results?: unknown } | undefined)?.results,
    (payload.data as { data?: unknown } | undefined)?.data,
    (payload.data as { web?: unknown } | undefined)?.web,
    (payload.web as { results?: unknown } | undefined)?.results,
  ];
  const rawItems = candidates.find((candidate) => Array.isArray(candidate));
  if (!Array.isArray(rawItems)) {
    return [];
  }
  const items: FirecrawlSearchItem[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined;
    const url =
      (typeof record.url === "string" && record.url) ||
      (typeof record.sourceURL === "string" && record.sourceURL) ||
      (typeof record.sourceUrl === "string" && record.sourceUrl) ||
      (typeof metadata?.sourceURL === "string" && metadata.sourceURL) ||
      "";
    if (!url) {
      continue;
    }
    const title =
      (typeof record.title === "string" && record.title) ||
      (typeof metadata?.title === "string" && metadata.title) ||
      "";
    const description =
      (typeof record.description === "string" && record.description) ||
      (typeof record.snippet === "string" && record.snippet) ||
      (typeof record.summary === "string" && record.summary) ||
      undefined;
    const content =
      (typeof record.markdown === "string" && record.markdown) ||
      (typeof record.content === "string" && record.content) ||
      (typeof record.text === "string" && record.text) ||
      undefined;
    const published =
      (typeof record.publishedDate === "string" && record.publishedDate) ||
      (typeof record.published === "string" && record.published) ||
      (typeof metadata?.publishedTime === "string" && metadata.publishedTime) ||
      (typeof metadata?.publishedDate === "string" && metadata.publishedDate) ||
      undefined;
    items.push({
      title,
      url,
      description,
      content,
      published,
      siteName: resolveSiteName(url),
    });
  }
  return items;
}

function buildSearchPayload(params: {
  query: string;
  provider: "firecrawl";
  items: FirecrawlSearchItem[];
  tookMs: number;
  scrapeResults: boolean;
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: params.provider,
    count: params.items.length,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results: params.items.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url,
      description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
      ...(entry.published ? { published: entry.published } : {}),
      ...(entry.siteName ? { siteName: entry.siteName } : {}),
      ...(params.scrapeResults && entry.content
        ? { content: wrapWebContent(entry.content, "web_search") }
        : {}),
    })),
  };
}

export async function runFirecrawlSearch(
  params: FirecrawlSearchParams,
): Promise<Record<string, unknown>> {
  const apiKey = resolveFirecrawlApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_search (firecrawl) needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure plugins.entries.firecrawl.config.webSearch.apiKey.",
    );
  }
  const count =
    typeof params.count === "number" && Number.isFinite(params.count)
      ? Math.max(1, Math.min(10, Math.floor(params.count)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveFirecrawlSearchTimeoutSeconds(params.timeoutSeconds);
  const scrapeResults = params.scrapeResults === true;
  const sources = Array.isArray(params.sources) ? params.sources.filter(Boolean) : [];
  const categories = Array.isArray(params.categories) ? params.categories.filter(Boolean) : [];
  const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "firecrawl-search",
      q: params.query,
      count,
      baseUrl,
      sources,
      categories,
      scrapeResults,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = {
    query: params.query,
    limit: count,
  };
  if (sources.length > 0) {
    body.sources = sources;
  }
  if (categories.length > 0) {
    body.categories = categories;
  }
  if (scrapeResults) {
    body.scrapeOptions = {
      formats: ["markdown"],
    };
  }

  const start = Date.now();
  const payload = await postFirecrawlJson({
    baseUrl,
    pathname: "/v2/search",
    apiKey,
    body,
    timeoutSeconds,
    errorLabel: "Firecrawl Search",
  });
  const result = buildSearchPayload({
    query: params.query,
    provider: "firecrawl",
    items: resolveSearchItems(payload),
    tookMs: Date.now() - start,
    scrapeResults,
  });
  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

function resolveScrapeData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return {};
}

export function parseFirecrawlScrapePayload(params: {
  payload: Record<string, unknown>;
  url: string;
  extractMode: "markdown" | "text";
  maxChars: number;
}): Record<string, unknown> {
  const data = resolveScrapeData(params.payload);
  const metadata =
    data.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : undefined;
  const markdown =
    (typeof data.markdown === "string" && data.markdown) ||
    (typeof data.content === "string" && data.content) ||
    "";
  if (!markdown) {
    throw new Error("Firecrawl scrape returned no content.");
  }
  const rawText = params.extractMode === "text" ? markdownToText(markdown) : markdown;
  const truncated = truncateText(rawText, params.maxChars);
  return {
    url: params.url,
    finalUrl:
      (typeof metadata?.sourceURL === "string" && metadata.sourceURL) ||
      (typeof data.url === "string" && data.url) ||
      params.url,
    status:
      (typeof metadata?.statusCode === "number" && metadata.statusCode) ||
      (typeof data.statusCode === "number" && data.statusCode) ||
      undefined,
    title:
      typeof metadata?.title === "string" && metadata.title
        ? wrapExternalContent(metadata.title, { source: "web_fetch", includeWarning: false })
        : undefined,
    extractor: "firecrawl",
    extractMode: params.extractMode,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated: truncated.truncated,
    rawLength: rawText.length,
    wrappedLength: wrapExternalContent(truncated.text, {
      source: "web_fetch",
      includeWarning: false,
    }).length,
    text: wrapExternalContent(truncated.text, {
      source: "web_fetch",
      includeWarning: false,
    }),
    warning:
      typeof params.payload.warning === "string" && params.payload.warning
        ? wrapExternalContent(params.payload.warning, {
            source: "web_fetch",
            includeWarning: false,
          })
        : undefined,
  };
}

export async function runFirecrawlScrape(
  params: FirecrawlScrapeParams,
): Promise<Record<string, unknown>> {
  const apiKey = resolveFirecrawlApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "firecrawl_scrape needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure tools.web.fetch.firecrawl.apiKey.",
    );
  }
  const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
  const timeoutSeconds = resolveFirecrawlScrapeTimeoutSeconds(params.cfg, params.timeoutSeconds);
  const onlyMainContent = resolveFirecrawlOnlyMainContent(params.cfg, params.onlyMainContent);
  const maxAgeMs = resolveFirecrawlMaxAgeMs(params.cfg, params.maxAgeMs);
  const proxy = params.proxy ?? "auto";
  const storeInCache = params.storeInCache ?? true;
  const maxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : DEFAULT_SCRAPE_MAX_CHARS;
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "firecrawl-scrape",
      url: params.url,
      extractMode: params.extractMode,
      baseUrl,
      onlyMainContent,
      maxAgeMs,
      proxy,
      storeInCache,
      maxChars,
    }),
  );
  const cached = readCache(SCRAPE_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const payload = await postFirecrawlJson({
    baseUrl,
    pathname: "/v2/scrape",
    apiKey,
    timeoutSeconds,
    errorLabel: "Firecrawl",
    body: {
      url: params.url,
      formats: ["markdown"],
      onlyMainContent,
      timeout: timeoutSeconds * 1000,
      maxAge: maxAgeMs,
      proxy,
      storeInCache,
    },
  });
  const result = parseFirecrawlScrapePayload({
    payload,
    url: params.url,
    extractMode: params.extractMode,
    maxChars,
  });
  writeCache(
    SCRAPE_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export const __testing = {
  parseFirecrawlScrapePayload,
  resolveSearchItems,
};
