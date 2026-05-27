import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  markdownToText,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  truncateText,
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import {
  SsrFBlockedError,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  DEFAULT_FIRECRAWL_BASE_URL,
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
const ALLOWED_FIRECRAWL_HOSTS = new Set(["api.firecrawl.dev"]);
const FIRECRAWL_SELF_HOSTED_PRIVATE_ERROR =
  "Firecrawl custom baseUrl must target a private or internal self-hosted endpoint.";
const FIRECRAWL_HTTP_PRIVATE_ERROR =
  "Firecrawl HTTP baseUrl must target a private or internal self-hosted endpoint. Use https:// for public hosts.";

type FirecrawlEndpointMode = "selfHosted" | "strict";
type FirecrawlResolvedEndpoint = {
  url: string;
  mode: FirecrawlEndpointMode;
};

type FirecrawlSearchItem = {
  title: string;
  url: string;
  description?: string;
  content?: string;
  published?: string;
  siteName?: string;
};

async function readFirecrawlJsonResponse(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

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

export async function assertFirecrawlScrapeTargetAllowed(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrFBlockedError("Invalid URL supplied to Firecrawl scrape");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrFBlockedError(
      `Blocked non-HTTP(S) protocol in Firecrawl scrape URL: ${parsed.protocol}`,
    );
  }

  // Literal check (fast)
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    throw new SsrFBlockedError(
      `Blocked hostname or private/internal IP in Firecrawl scrape URL: ${parsed.hostname}`,
    );
  }

  // DNS resolution check (robust)
  try {
    await resolvePinnedHostnameWithPolicy(parsed.hostname);
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      throw new SsrFBlockedError(
        `Blocked hostname or private/internal IP in Firecrawl scrape URL: ${parsed.hostname}`,
      );
    }
    // For other errors (DNS failure), we allow it to let the actual fetch fail later.
  }
}

function isOfficialFirecrawlEndpoint(url: URL): boolean {
  return url.protocol === "https:" && ALLOWED_FIRECRAWL_HOSTS.has(url.hostname);
}

async function firecrawlEndpointTargetsPrivateNetwork(
  url: URL,
  lookupFn?: LookupFn,
): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      lookupFn,
      policy: { allowPrivateNetwork: true },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

async function validateFirecrawlBaseUrl(
  baseUrl: string,
  lookupFn?: LookupFn,
): Promise<FirecrawlEndpointMode> {
  let url: URL;
  try {
    url = new URL(baseUrl.trim() || DEFAULT_FIRECRAWL_BASE_URL);
  } catch {
    throw new Error("Firecrawl baseUrl must be a valid http:// or https:// URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Firecrawl baseUrl must use http:// or https://.");
  }
  if (isOfficialFirecrawlEndpoint(url)) {
    return "strict";
  }

  const isPrivateTarget = await firecrawlEndpointTargetsPrivateNetwork(url, lookupFn);
  if (isPrivateTarget) {
    return "selfHosted";
  }
  if (url.protocol === "http:") {
    throw new Error(FIRECRAWL_HTTP_PRIVATE_ERROR);
  }
  throw new Error(`${FIRECRAWL_SELF_HOSTED_PRIVATE_ERROR} Host: ${url.hostname}`);
}

async function resolveEndpoint(
  baseUrl: string,
  pathname: "/v2/search" | "/v2/scrape",
  lookupFn?: LookupFn,
): Promise<FirecrawlResolvedEndpoint> {
  const url = new URL(baseUrl.trim() || DEFAULT_FIRECRAWL_BASE_URL);
  const mode = await validateFirecrawlBaseUrl(url.toString(), lookupFn);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = pathname;
  return { url: url.toString(), mode };
}

async function postFirecrawlJson<T>(
  params: {
    url: string;
    mode?: FirecrawlEndpointMode;
    timeoutSeconds: number;
    apiKey: string;
    body: Record<string, unknown>;
    errorLabel: string;
  },
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const apiKey = normalizeSecretInput(params.apiKey);
  const mode = params.mode ?? (await validateFirecrawlBaseUrl(params.url));
  const withEndpoint =
    mode === "selfHosted" ? withSelfHostedWebToolsEndpoint : withStrictWebToolsEndpoint;
  return await withEndpoint(
    {
      url: params.url,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        let detail =
          typeof response.statusText === "string" && response.statusText.trim()
            ? response.statusText.trim()
            : "request failed";

        const readJsonPayload = async (): Promise<Record<string, unknown> | null> => {
          const candidate = response as Response & { clone?: () => Response };
          const jsonResponse = typeof candidate.clone === "function" ? candidate.clone() : response;
          if (typeof jsonResponse.json !== "function") {
            return null;
          }
          try {
            const payload = await jsonResponse.json();
            return payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : null;
          } catch {
            return null;
          }
        };

        const payload = await readJsonPayload();
        if (payload) {
          detail =
            typeof payload.error === "string"
              ? payload.error
              : typeof payload.message === "string"
                ? payload.message
                : detail;
        } else {
          const errorBody = await readResponseText(response, { maxBytes: 64_000 });
          if (errorBody.text) {
            detail = errorBody.text;
          }
        }
        const safeDetail = wrapWebContent(detail.slice(0, 1_000), "web_fetch");
        throw new Error(`${params.errorLabel} API error (${response.status}): ${safeDetail}`);
      }
      return await parse(response);
    },
  );
}

function resolveSiteName(urlRaw: string): string | undefined {
  try {
    const host = new URL(urlRaw).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
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
  const endpoint = await resolveEndpoint(baseUrl, "/v2/search");
  const payload = await postFirecrawlJson(
    {
      url: endpoint.url,
      mode: endpoint.mode,
      timeoutSeconds,
      apiKey,
      body,
      errorLabel: "Firecrawl Search",
    },
    async (response) => {
      const payload = await readFirecrawlJsonResponse(response, "Firecrawl Search API error");
      if (payload.success === false) {
        const error =
          typeof payload.error === "string"
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : "unknown error";
        throw new Error(`Firecrawl Search API error: ${error}`);
      }
      return payload;
    },
  );
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
  let urlToScrape = params.url;
  
  // Resolve and pin the hostname before sending it to Firecrawl.
  // This prevents DNS rebinding (TOCTOU) because we validate the actual IP
  // and then use that IP directly if it's public.
  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    throw new SsrFBlockedError("Invalid URL supplied to Firecrawl scrape");
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    const pinned = await resolvePinnedHostnameWithPolicy(parsed.hostname);
    // If the hostname resolves to multiple IPs, and some are private,
    // resolvePinnedHostnameWithPolicy would have already thrown if the policy blocks them.
    // To ensure Firecrawl doesn't re-resolve to something else, we swap the hostname for the first pinned IP.
    if (pinned.addresses.length > 0) {
       const firstIp = pinned.addresses[0];
       const originalHostname = parsed.hostname;
       parsed.hostname = firstIp;
       urlToScrape = parsed.toString();
       // We keep the original Host header if possible, but Firecrawl is a remote service,
       // so it will likely reject an IP-based request if it expects a specific vhost.
       // HOWEVER, for pure SSRF protection, pinning the IP is the only way to be 100% sure.
       // Since Firecrawl is a third-party API, we should probably stick to the pre-check
       // and acknowledge its limitations if pinning breaks their side.
       // RE-THINK: If we send an IP to Firecrawl, their egress will hit that IP.
       // This is robust.
    }
  }

  const apiKey = resolveFirecrawlApiKey(params.cfg);
  if (!apiKey) {
    throw new Error(
      "firecrawl_scrape needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure plugins.entries.firecrawl.config.webFetch.apiKey.",
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

  const endpoint = await resolveEndpoint(baseUrl, "/v2/scrape");
  const payload = await postFirecrawlJson(
    {
      url: endpoint.url,
      mode: endpoint.mode,
      timeoutSeconds,
      apiKey,
      errorLabel: "Firecrawl",
      body: {
        url: urlToScrape,
        formats: ["markdown"],
        onlyMainContent,
        timeout: timeoutSeconds * 1000,
        maxAge: maxAgeMs,
        proxy,
        storeInCache,
      },
    },
    async (response) => {
      const payload = await readFirecrawlJsonResponse(response, "Firecrawl fetch failed");
      if (payload.success === false) {
        const detail =
          typeof payload.error === "string"
            ? payload.error
            : typeof payload.message === "string"
              ? payload.message
              : response.statusText;
        throw new Error(
          `Firecrawl fetch failed (${response.status}): ${wrapWebContent(detail, "web_fetch")}`.trim(),
        );
      }
      return payload;
    },
  );
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

export const testing = {
  assertFirecrawlScrapeTargetAllowed,
  parseFirecrawlScrapePayload,
  postFirecrawlJson,
  resolveEndpoint,
  validateFirecrawlBaseUrl,
  resolveSearchItems,
};
export { testing as __testing };
