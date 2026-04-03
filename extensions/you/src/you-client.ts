import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  withTrustedWebToolsEndpoint,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  resolveContentsTimeoutSeconds,
  resolveResearchTimeoutSeconds,
  resolveSearchTimeoutSeconds,
  resolveYouApiKey,
  YOU_RESEARCH_BASE_URL,
  YOU_SEARCH_BASE_URL,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const RESEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const CONTENTS_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();

const DEFAULT_SEARCH_COUNT = 10;
const RESEARCH_EFFORTS = ["lite", "standard", "deep", "exhaustive"] as const;
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number];

export function isValidResearchEffort(value: string): value is ResearchEffort {
  return RESEARCH_EFFORTS.includes(value as ResearchEffort);
}

// Freshness mapping: user-friendly -> API values
const FRESHNESS_MAP: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export type YouSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  count?: number;
  freshness?: string;
  country?: string;
  safesearch?: string;
  timeoutSeconds?: number;
};

export type YouResearchParams = {
  cfg?: OpenClawConfig;
  input: string;
  researchEffort?: ResearchEffort;
  timeoutSeconds?: number;
};

export type YouContentsParams = {
  cfg?: OpenClawConfig;
  urls: string[];
  formats?: string[];
  crawlTimeout?: number;
  timeoutSeconds?: number;
};

type YouSearchResponse = {
  results?: {
    web?: Array<{
      url?: string;
      title?: string;
      description?: string;
      snippets?: string[];
      page_age?: string;
    }>;
    news?: Array<{
      url?: string;
      title?: string;
      description?: string;
      page_age?: string;
    }>;
  };
  metadata?: {
    search_uuid?: string;
    query?: string;
    latency?: number;
  };
};

type YouResearchResponse = {
  output?: {
    content?: string;
    content_type?: string;
    sources?: Array<{
      url?: string;
      title?: string;
      snippets?: string[];
    }>;
  };
};

type YouContentsResponse = Array<{
  url?: string;
  title?: string | null;
  html?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
}>;

export async function runYouSearch(params: YouSearchParams): Promise<Record<string, unknown>> {
  // You.com Search API works without API key (free tier) but with rate limits
  const apiKey = resolveYouApiKey(params.cfg);
  const count =
    typeof params.count === "number" && Number.isFinite(params.count)
      ? Math.max(1, Math.min(100, Math.floor(params.count)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveSearchTimeoutSeconds(params.timeoutSeconds);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "you-search",
      q: params.query,
      count,
      freshness: params.freshness,
      country: params.country,
      safesearch: params.safesearch,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const url = new URL(`${YOU_SEARCH_BASE_URL}/v1/search`);
  url.searchParams.set("query", params.query);
  url.searchParams.set("count", String(count));
  if (params.freshness) {
    const mapped = FRESHNESS_MAP[params.freshness.toLowerCase()] ?? params.freshness;
    url.searchParams.set("freshness", mapped);
  }
  if (params.country) {
    url.searchParams.set("country", params.country.toUpperCase());
  }
  if (params.safesearch) {
    url.searchParams.set("safesearch", params.safesearch.toLowerCase());
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const start = Date.now();
  const payload = await withTrustedWebToolsEndpoint(
    {
      url: url.toString(),
      timeoutSeconds,
      init: {
        method: "GET",
        headers,
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, { maxBytes: 64_000 });
        throw new Error(
          `You.com Search API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      return (await response.json()) as YouSearchResponse;
    },
  );

  const webResults = (payload.results?.web ?? []).map((r) => ({
    title: typeof r.title === "string" ? wrapWebContent(r.title, "web_search") : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet:
      typeof r.description === "string"
        ? wrapWebContent(r.description, "web_search")
        : r.snippets?.length
          ? wrapWebContent(r.snippets.join(" "), "web_search")
          : "",
    ...(typeof r.page_age === "string" ? { published: r.page_age } : {}),
  }));

  const newsResults = (payload.results?.news ?? []).map((r) => ({
    title: typeof r.title === "string" ? wrapWebContent(r.title, "web_search") : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.description === "string" ? wrapWebContent(r.description, "web_search") : "",
    ...(typeof r.page_age === "string" ? { published: r.page_age } : {}),
    type: "news",
  }));

  // Combine web and news results
  const results = [...webResults, ...newsResults];

  const result: Record<string, unknown> = {
    query: params.query,
    provider: "you",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "you",
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

export async function runYouResearch(params: YouResearchParams): Promise<Record<string, unknown>> {
  const apiKey = resolveYouApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_research needs a You.com API key. Set YDC_API_KEY in the Gateway environment, or configure plugins.entries.you.config.webSearch.apiKey.",
    );
  }

  const effort = params.researchEffort ?? "standard";
  const timeoutSeconds = resolveResearchTimeoutSeconds(effort, params.timeoutSeconds);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "you-research",
      input: params.input,
      effort,
    }),
  );
  const cached = readCache(RESEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();
  const payload = await withTrustedWebToolsEndpoint(
    {
      url: `${YOU_RESEARCH_BASE_URL}/v1/research`,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          input: params.input,
          research_effort: effort,
        }),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, { maxBytes: 64_000 });
        throw new Error(
          `You.com Research API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      return (await response.json()) as YouResearchResponse;
    },
  );

  const content = payload.output?.content ?? "No response";
  const sources = (payload.output?.sources ?? [])
    .filter((s) => typeof s.url === "string" && s.url)
    .map((s) => ({
      url: s.url!,
      title: s.title ? wrapWebContent(s.title, "web_research") : undefined,
    }));

  const result: Record<string, unknown> = {
    input: params.input,
    effort,
    provider: "you",
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_research",
      provider: "you",
      wrapped: true,
    },
    content: wrapWebContent(content, "web_research"),
    sources,
  };

  writeCache(
    RESEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export async function runYouContents(params: YouContentsParams): Promise<Record<string, unknown>> {
  const apiKey = resolveYouApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "web_contents needs a You.com API key. Set YDC_API_KEY in the Gateway environment, or configure plugins.entries.you.config.webSearch.apiKey.",
    );
  }

  const timeoutSeconds = resolveContentsTimeoutSeconds(params.timeoutSeconds);
  const formats = params.formats ?? ["markdown"];

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "you-contents",
      urls: params.urls,
      formats,
      crawlTimeout: params.crawlTimeout,
    }),
  );
  const cached = readCache(CONTENTS_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = {
    urls: params.urls,
    formats,
  };
  if (params.crawlTimeout && params.crawlTimeout > 0) {
    body.crawl_timeout = Math.min(60, params.crawlTimeout);
  }

  const start = Date.now();
  const payload = await withTrustedWebToolsEndpoint(
    {
      url: `${YOU_SEARCH_BASE_URL}/v1/contents`,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detail = await readResponseText(response, { maxBytes: 64_000 });
        throw new Error(
          `You.com Contents API error (${response.status}): ${detail.text || response.statusText}`,
        );
      }
      return (await response.json()) as YouContentsResponse;
    },
  );

  const results = (Array.isArray(payload) ? payload : []).map((r) => ({
    url: typeof r.url === "string" ? r.url : "",
    title: r.title ? wrapWebContent(r.title, "web_fetch") : undefined,
    ...(r.markdown
      ? {
          markdown: wrapExternalContent(r.markdown, { source: "web_fetch", includeWarning: false }),
        }
      : {}),
    ...(r.html
      ? { html: wrapExternalContent(r.html, { source: "web_fetch", includeWarning: false }) }
      : {}),
    ...(r.metadata ? { metadata: r.metadata } : {}),
  }));

  const result: Record<string, unknown> = {
    provider: "you",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      provider: "you",
      wrapped: true,
    },
    results,
  };

  writeCache(
    CONTENTS_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export const __testing = {
  FRESHNESS_MAP,
  RESEARCH_EFFORTS,
};
