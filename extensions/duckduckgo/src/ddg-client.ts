import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readPluginPackageVersion } from "openclaw/plugin-sdk/extension-shared";
import { decodeHtmlEntities as decodeHtmlEntity } from "openclaw/plugin-sdk/html-entity-runtime";
import { ProviderHttpError, readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";
import {
  externalContentStamp,
  DEFAULT_SEARCH_COUNT,
  readCachedSearchPayload,
  readResponseText,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveProviderWebSearchPluginConfig } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type DdgSafeSearch = "strict" | "moderate" | "off";

const require = createRequire(import.meta.url);
const PLUGIN_VERSION = readPluginPackageVersion({ require });
// Identify the plugin rather than impersonating a browser; challenges can still occur.
const DDG_USER_AGENT = `openclaw-duckduckgo/${PLUGIN_VERSION} (+https://docs.openclaw.ai)`;

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const DEFAULT_TIMEOUT_SECONDS = 20;
const DDG_HTML_ENTITY_RE =
  /&(?:lt|gt|quot|apos|#39|#x27|#x2F|nbsp|ndash|mdash|hellip|amp|#\d+|#x[0-9a-f]+);/gi;
const DDG_ENTITY_TEXT: Readonly<Record<string, string>> = {
  "\u00a0": " ",
  "–": "-",
  "—": "--",
  "…": "...",
};
const DDG_SAFE_SEARCH_PARAM: Record<DdgSafeSearch, string> = {
  strict: "1",
  moderate: "-1",
  off: "-2",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(DDG_HTML_ENTITY_RE, (entity) => {
    const decoded = decodeHtmlEntity(entity.startsWith("&#") ? entity : entity.toLowerCase());
    return DDG_ENTITY_TEXT[decoded] ?? decoded;
  });
}

function stripHtml(html: string): string {
  // DuckDuckGo match highlights can occur inside words, so remove them without adding whitespace.
  const withoutMatchHighlights = html.replace(/<\/?b\b[^>]*>/gi, "");
  return withoutMatchHighlights
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runDuckDuckGoSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  region?: string;
  safeSearch?: DdgSafeSearch;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const region =
    params.region ??
    normalizeOptionalString(
      resolveProviderWebSearchPluginConfig(params.config, "duckduckgo")?.region,
    );
  let safeSearch = params.safeSearch;
  if (safeSearch == null) {
    const normalized = normalizeLowercaseStringOrEmpty(
      resolveProviderWebSearchPluginConfig(params.config, "duckduckgo")?.safeSearch,
    );
    safeSearch = normalized === "strict" || normalized === "off" ? normalized : "moderate";
  }
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveSearchCacheTtlMs(params.config?.tools?.web?.search);
  const cacheKey = JSON.stringify({
    provider: "duckduckgo",
    query: params.query,
    count,
    region: region ?? "",
    safeSearch,
  });
  const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
  if (cached) {
    return cached;
  }

  const url = new URL(DDG_HTML_ENDPOINT);
  url.searchParams.set("q", params.query);
  if (region) {
    url.searchParams.set("kl", region);
  }
  url.searchParams.set("kp", DDG_SAFE_SEARCH_PARAM[safeSearch]);

  const startedAt = Date.now();
  const results = await withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds,
      signal: params.signal,
      init: {
        method: "GET",
        headers: {
          "User-Agent": DDG_USER_AGENT,
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new ProviderHttpError(
          `DuckDuckGo search error (${response.status}): ${detail || response.statusText}`,
          { status: response.status },
        );
      }

      const html = await readProviderTextResponse(response, "DuckDuckGo search");
      if (
        !/class="[^"]*\bresult__a\b[^"]*"/i.test(html) &&
        /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html)
      ) {
        throw new Error("DuckDuckGo returned a bot-detection challenge.");
      }
      const parsedResults: { title: string; url: string; snippet: string }[] = [];
      const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
      const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
      const snippetRegex =
        /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

      for (const match of html.matchAll(resultRegex)) {
        const rawAttributes = match[1] ?? "";
        const rawTitle = match[2] ?? "";
        const rawUrl = /\bhref="([^"]*)"/i.exec(rawAttributes)?.[1] ?? "";
        const matchEnd = (match.index ?? 0) + match[0].length;
        const trailingHtml = html.slice(matchEnd);
        const nextResultIndex = trailingHtml.search(nextResultRegex);
        const scopedTrailingHtml =
          nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
        const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";
        const title = decodeHtmlEntities(stripHtml(rawTitle));
        let resultUrl = decodeHtmlEntities(rawUrl);
        try {
          const normalized = resultUrl.startsWith("//") ? `https:${resultUrl}` : resultUrl;
          const parsed = new URL(normalized);
          const uddg = parsed.searchParams.get("uddg");
          if (uddg) {
            resultUrl = uddg;
          }
        } catch {
          // Keep the original value when DuckDuckGo already returns a direct link.
        }
        const snippet = decodeHtmlEntities(stripHtml(rawSnippet));

        if (title && resultUrl) {
          parsedResults.push({ title, url: resultUrl, snippet });
          if (parsedResults.length >= count) {
            break;
          }
        }
      }

      return parsedResults;
    },
  );

  params.signal?.throwIfAborted();
  const payload = {
    query: params.query,
    provider: "duckduckgo",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: externalContentStamp("duckduckgo"),
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  return payload;
}
