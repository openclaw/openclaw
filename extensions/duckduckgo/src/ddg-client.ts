import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveDdgRegion, resolveDdgSafeSearch, type DdgSafeSearch } from "./config.js";

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const DEFAULT_TIMEOUT_SECONDS = 20;
const DDG_SAFE_SEARCH_PARAM: Record<DdgSafeSearch, string> = {
  strict: "1",
  moderate: "-1",
  off: "-2",
};

// How long to suppress new requests after bot-detection or rate-limiting.
// DuckDuckGo uses sliding-window IP blocks; 60 s is a conservative minimum
// that stops the agent from hammering DDG and making the block worse.
const DDG_COOLDOWN_BOT_CHALLENGE_MS = 60_000;
const DDG_COOLDOWN_RATE_LIMIT_MS = 30_000;

let ddgCooldownUntil = 0;

function activateCooldown(ms: number): void {
  ddgCooldownUntil = Math.max(ddgCooldownUntil, Date.now() + ms);
}

function getCooldownError(): Error | null {
  const remaining = ddgCooldownUntil - Date.now();
  if (remaining <= 0) return null;
  const secs = Math.ceil(remaining / 1000);
  return new Error(
    `DuckDuckGo rate-limit cooldown active — try again in ${secs}s.`,
  );
}

const DDG_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type DuckDuckGoResult = {
  title: string;
  url: string;
  snippet: string;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(normalized);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return uddg;
    }
  } catch {
    // Keep the original value when DuckDuckGo already returns a direct link.
  }
  return rawUrl;
}

function readHrefAttribute(tagAttributes: string): string {
  return /\bhref="([^"]*)"/i.exec(tagAttributes)?.[1] ?? "";
}

function isBotChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) {
    return false;
  }
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}

function parseDuckDuckGoHtml(html: string): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = [];
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

  for (const match of html.matchAll(resultRegex)) {
    const rawAttributes = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawUrl = readHrefAttribute(rawAttributes);
    const matchEnd = (match.index ?? 0) + match[0].length;
    const trailingHtml = html.slice(matchEnd);
    const nextResultIndex = trailingHtml.search(nextResultRegex);
    const scopedTrailingHtml =
      nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
    const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";
    const title = decodeHtmlEntities(stripHtml(rawTitle));
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const snippet = decodeHtmlEntities(stripHtml(rawSnippet));

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

export async function runDuckDuckGoSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  region?: string;
  safeSearch?: DdgSafeSearch;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const region = params.region ?? resolveDdgRegion(params.config);
  const safeSearch =
    params.safeSearch === "strict" ||
    params.safeSearch === "moderate" ||
    params.safeSearch === "off"
      ? params.safeSearch
      : resolveDdgSafeSearch(params.config);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "duckduckgo",
      query: params.query,
      count,
      region: region ?? "",
      safeSearch,
    }),
  );
  const cached = readCache(DDG_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const cooldownError = getCooldownError();
  if (cooldownError) throw cooldownError;

  // DDG's html endpoint expects POST with form-encoded body, not a GET with
  // query params. Using GET reliably triggers bot-detection; POST mimics a
  // real browser form submission and avoids the challenge page.
  const formBody = new URLSearchParams();
  formBody.set("q", params.query);
  if (region) formBody.set("kl", region);
  formBody.set("kp", DDG_SAFE_SEARCH_PARAM[safeSearch]);

  const startedAt = Date.now();
  const results = await withTrustedWebSearchEndpoint(
    {
      url: DDG_HTML_ENDPOINT,
      timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Site": "same-origin",
          Referer: "https://duckduckgo.com/",
        },
        body: formBody.toString(),
      },
    },
    async (response) => {
      // HTTP 202 is DDG's non-standard rate-limit signal (not 429).
      if (response.status === 202) {
        activateCooldown(DDG_COOLDOWN_RATE_LIMIT_MS);
        throw new Error(
          `DuckDuckGo rate limit (HTTP 202) — retry in ${DDG_COOLDOWN_RATE_LIMIT_MS / 1000}s.`,
        );
      }
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(
          `DuckDuckGo search error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const html = await response.text();
      if (isBotChallenge(html)) {
        activateCooldown(DDG_COOLDOWN_BOT_CHALLENGE_MS);
        throw new Error(
          `DuckDuckGo bot-detection challenge — retry in ${DDG_COOLDOWN_BOT_CHALLENGE_MS / 1000}s.`,
        );
      }
      return parseDuckDuckGoHtml(html).slice(0, count);
    },
  );

  const payload = {
    query: params.query,
    provider: "duckduckgo",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "duckduckgo",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(DDG_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  decodeDuckDuckGoUrl,
  decodeHtmlEntities,
  isBotChallenge,
  parseDuckDuckGoHtml,
  getCooldownError,
  resetCooldown: () => {
    ddgCooldownUntil = 0;
  },
  activateCooldown,
};
