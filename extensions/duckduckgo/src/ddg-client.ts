import {
  resolveDdgRegion,
  resolveDdgSafeSearch,
  resolveDdgSearchTimeoutSeconds,
} from "./config.js";

const DEFAULT_CACHE_TTL_MINUTES = 5;

function normalizeCacheKey(key: string): string {
  return key;
}

type CacheEntry = { value: Record<string, unknown>; expiresAt: number; insertedAt: number };

function readCache(
  cache: Map<string, CacheEntry>,
  key: string,
): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function writeCache(
  cache: Map<string, CacheEntry>,
  key: string,
  value: Record<string, unknown>,
  ttlMs: number,
): void {
  const now = Date.now();
  cache.set(key, { value, expiresAt: now + ttlMs, insertedAt: now });
}

function resolveCacheTtlMs(override: number | undefined, defaultMinutes: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return override * 60_000;
  }
  return defaultMinutes * 60_000;
}

function wrapWebContent(text: string, _source: string): string {
  return text;
}

const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;

export type DdgSearchParams = {
  cfg?: { plugins?: { entries?: Record<string, { config?: unknown }> } };
  query: string;
  maxResults?: number;
  region?: string;
  timeoutSeconds?: number;
};

type DdgLiteResult = {
  title: string;
  url: string;
  snippet: string;
};

const SAFE_SEARCH_MAP: Record<string, string> = {
  strict: "1",
  moderate: "-1",
  off: "-2",
};

/**
 * Parse DuckDuckGo Lite HTML response into structured results.
 *
 * The Lite page renders results as a table with a predictable layout:
 * - Each result has a link row followed by a snippet row.
 * - Links live inside `<a class="result-link">` (or plain `<a>` in the
 *   result-title cell).
 * - Snippets live inside `<td class="result-snippet">`.
 */
export function parseDdgLiteHtml(html: string): DdgLiteResult[] {
  const results: DdgLiteResult[] = [];

  // Match <a> tags that contain class="result-link" (attributes may appear in any order)
  const linkTagPattern = /<a\s+[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi;
  const hrefPattern = /href="([^"]*)"/i;
  const snippetPattern = /<td\s+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkTagPattern.exec(html)) !== null) {
    const fullTag = linkMatch[0];
    const hrefMatch = fullTag.match(hrefPattern);
    const url = hrefMatch ? decodeHtmlEntities(hrefMatch[1].trim()) : "";
    const title = stripHtml(linkMatch[1]).trim();
    if (url && title) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetPattern.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1]).trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? "",
    });
  }

  return results;
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&hellip;/g, "\u2026")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export async function runDdgSearch(
  params: DdgSearchParams,
): Promise<Record<string, unknown>> {
  const count =
    typeof params.maxResults === "number" && Number.isFinite(params.maxResults)
      ? Math.max(1, Math.min(25, Math.floor(params.maxResults)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveDdgSearchTimeoutSeconds(params.timeoutSeconds);
  const region = params.region ?? resolveDdgRegion(params.cfg) ?? "";
  const safeSearch = resolveDdgSafeSearch(params.cfg);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "ddg-search",
      q: params.query,
      count,
      region,
      safeSearch,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  const formBody = new URLSearchParams();
  formBody.set("q", params.query);
  if (region) {
    formBody.set("kl", region);
  }
  formBody.set("kp", SAFE_SEARCH_MAP[safeSearch] ?? "-1");
  // Request the lite HTML version
  formBody.set("df", "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  let rawResults: DdgLiteResult[];
  try {
    const response = await fetch(DDG_LITE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Origin: "https://lite.duckduckgo.com",
        Referer: "https://lite.duckduckgo.com/",
      },
      body: formBody.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`DuckDuckGo search error (${response.status}): ${detail}`);
    }
    const html = await response.text();
    if (
      html.includes("Select all squares") ||
      html.includes("challenge") ||
      html.includes("captcha") ||
      html.includes("are you a human") ||
      html.includes("g-recaptcha")
    ) {
      throw new Error(
        "DuckDuckGo returned a bot-detection challenge. Try again later or reduce request frequency.",
      );
    }
    rawResults = parseDdgLiteHtml(html);
  } finally {
    clearTimeout(timer);
  }

  const results = rawResults.slice(0, count).map((entry) => ({
    title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
    url: entry.url,
    snippet: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
    siteName: resolveSiteName(entry.url) || undefined,
  }));

  const result: Record<string, unknown> = {
    query: params.query,
    provider: "duckduckgo",
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "duckduckgo",
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

export const __testing = {
  parseDdgLiteHtml,
  SEARCH_CACHE,
};
