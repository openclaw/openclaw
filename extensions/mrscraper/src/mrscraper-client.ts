import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  readResponseText,
  resolveTimeoutSeconds,
  withStrictWebToolsEndpoint,
  wrapExternalContent,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  resolveMrScraperApiToken,
  resolveMrScraperBlockResources,
  resolveMrScraperFetchTimeoutSeconds,
  resolveMrScraperGeoCode,
  resolveMrScraperPlatformBaseUrl,
  resolveMrScraperProxyCountry,
  resolveMrScraperScrapeTimeoutSeconds,
  resolveMrScraperUnblockerBaseUrl,
} from "./config.js";

const ALLOWED_UNBLOCKER_HOSTS = new Set(["api.mrscraper.com"]);
const ALLOWED_PLATFORM_HOSTS = new Set(["api.app.mrscraper.com", "sync.scraper.mrscraper.com"]);
const DEFAULT_FETCH_MAX_CHARS = 50_000;

export type MrScraperFetchHtmlParams = {
  cfg?: OpenClawConfig;
  url: string;
  extractMode: "markdown" | "text";
  maxChars?: number;
  timeoutSeconds?: number;
  geoCode?: string;
  blockResources?: boolean;
};

export type MrScraperCreateAiScraperParams = {
  cfg?: OpenClawConfig;
  url: string;
  message: string;
  agent?: "general" | "listing" | "map";
  proxyCountry?: string;
  maxDepth?: number;
  maxPages?: number;
  limit?: number;
  includePatterns?: string;
  excludePatterns?: string;
  timeoutSeconds?: number;
};

function resolveEndpoint(params: {
  baseUrl: string;
  defaultBaseUrl: string;
  pathname?: string;
  allowedHosts: Set<string>;
  product: string;
}): string {
  const candidate = params.baseUrl.trim() || params.defaultBaseUrl;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    url = new URL(params.defaultBaseUrl);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${params.product} baseUrl must use https.`);
  }
  if (!params.allowedHosts.has(url.hostname)) {
    throw new Error(`${params.product} baseUrl host is not allowed: ${url.hostname}`);
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (params.pathname) {
    url.pathname = params.pathname;
  }
  return url.toString();
}

async function throwHttpError(response: Response, label: string): Promise<never> {
  let detail =
    typeof response.statusText === "string" && response.statusText.trim()
      ? response.statusText.trim()
      : "request failed";

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as Record<string, unknown>;
      detail =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.error === "string"
            ? payload.error
            : detail;
    } catch {
      // Ignore and fall back to text body parsing below.
    }
  } else {
    const errorBody = await readResponseText(response, { maxBytes: 64_000 });
    if (errorBody.text) {
      detail = errorBody.text;
    }
  }

  throw new Error(
    `${label} API error (${response.status}): ${wrapWebContent(detail, "web_fetch")}`,
  );
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) {
    return undefined;
  }
  return decodeHtmlEntities(match[1]).trim() || undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|section|article|main|header|footer|aside|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function normalizeMaxChars(maxChars?: number): number {
  if (typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0) {
    return Math.floor(maxChars);
  }
  return DEFAULT_FETCH_MAX_CHARS;
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: value.slice(0, Math.max(0, maxChars - 1)).trimEnd(),
    truncated: true,
  };
}

export async function runMrScraperFetchHtml(
  params: MrScraperFetchHtmlParams,
): Promise<Record<string, unknown>> {
  const apiToken = resolveMrScraperApiToken(params.cfg);
  if (!apiToken) {
    throw new Error(
      "web_fetch (mrscraper) needs a MrScraper API token. Set MRSCRAPER_API_TOKEN in the Gateway environment, or configure plugins.entries.mrscraper.config.apiToken.",
    );
  }

  const baseUrl = resolveEndpoint({
    baseUrl: resolveMrScraperUnblockerBaseUrl(params.cfg),
    defaultBaseUrl: "https://api.mrscraper.com",
    allowedHosts: ALLOWED_UNBLOCKER_HOSTS,
    product: "MrScraper unblocker",
  });
  const timeoutSeconds = resolveTimeoutSeconds(
    params.timeoutSeconds,
    resolveMrScraperFetchTimeoutSeconds(params.cfg),
  );
  const url = new URL(baseUrl);
  url.searchParams.set("token", normalizeSecretInput(apiToken));
  url.searchParams.set("url", params.url);
  url.searchParams.set("timeout", String(timeoutSeconds));
  const geoCode = resolveMrScraperGeoCode(params.cfg, params.geoCode);
  if (geoCode) {
    url.searchParams.set("geoCode", geoCode);
  }
  if (resolveMrScraperBlockResources(params.cfg, params.blockResources)) {
    url.searchParams.set("blockResources", "true");
  }

  const start = Date.now();
  const html = await withStrictWebToolsEndpoint(
    {
      url: url.toString(),
      timeoutSeconds,
    },
    async ({ response }) => {
      if (!response.ok) {
        await throwHttpError(response, "MrScraper unblocker");
      }
      return await response.text();
    },
  );

  const title = extractTitle(html);
  const plainText = htmlToPlainText(html);
  const maxChars = normalizeMaxChars(params.maxChars);
  const htmlResult = truncate(html, maxChars);
  const textResult = truncate(plainText, maxChars);
  const requestedText = params.extractMode === "text" ? textResult.text : htmlResult.text;
  const requestedTruncated =
    params.extractMode === "text" ? textResult.truncated : htmlResult.truncated;

  return {
    url: params.url,
    title,
    status: 200,
    contentType: "text/html",
    extractor: "mrscraper",
    tookMs: Date.now() - start,
    truncated: requestedTruncated,
    warning:
      params.extractMode === "markdown"
        ? "MrScraper returns rendered HTML for unblocker requests; markdown mode returns the rendered HTML payload."
        : undefined,
    text:
      params.extractMode === "text"
        ? requestedText
        : wrapExternalContent(requestedText, { source: "web_fetch", includeWarning: false }),
    html: wrapExternalContent(htmlResult.text, { source: "web_fetch", includeWarning: false }),
    renderedText: wrapExternalContent(textResult.text, {
      source: "web_fetch",
      includeWarning: false,
    }),
  };
}

export async function runMrScraperCreateAiScraper(
  params: MrScraperCreateAiScraperParams,
): Promise<Record<string, unknown>> {
  const apiToken = resolveMrScraperApiToken(params.cfg);
  if (!apiToken) {
    throw new Error(
      "mrscraper_scrape needs a MrScraper API token. Set MRSCRAPER_API_TOKEN in the Gateway environment, or configure plugins.entries.mrscraper.config.apiToken.",
    );
  }

  const endpoint = resolveEndpoint({
    baseUrl: resolveMrScraperPlatformBaseUrl(params.cfg),
    defaultBaseUrl: "https://api.app.mrscraper.com",
    pathname: "/api/v1/scrapers-ai",
    allowedHosts: ALLOWED_PLATFORM_HOSTS,
    product: "MrScraper platform",
  });
  const timeoutSeconds = resolveTimeoutSeconds(
    params.timeoutSeconds,
    resolveMrScraperScrapeTimeoutSeconds(params.cfg),
  );

  const body: Record<string, unknown> = {
    url: params.url,
    message: params.message,
    agent: params.agent ?? "general",
  };
  const proxyCountry = resolveMrScraperProxyCountry(params.cfg, params.proxyCountry);
  if (proxyCountry) {
    body.proxyCountry = proxyCountry;
  }
  if (params.agent === "map") {
    if (typeof params.maxDepth === "number") body.maxDepth = Math.floor(params.maxDepth);
    if (typeof params.maxPages === "number") body.maxPages = Math.floor(params.maxPages);
    if (typeof params.limit === "number") body.limit = Math.floor(params.limit);
    if (params.includePatterns) body.includePatterns = params.includePatterns;
    if (params.excludePatterns) body.excludePatterns = params.excludePatterns;
  }

  const start = Date.now();
  const payload = await withStrictWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-token": normalizeSecretInput(apiToken),
        },
        body: JSON.stringify(body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        await throwHttpError(response, "MrScraper AI scraper");
      }
      return (await response.json()) as Record<string, unknown>;
    },
  );

  return {
    provider: "mrscraper",
    operation: "create_ai_scraper",
    tookMs: Date.now() - start,
    ...payload,
  };
}

export const __testing = {
  decodeHtmlEntities,
  extractTitle,
  htmlToPlainText,
  resolveEndpoint,
};
