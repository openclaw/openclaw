import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  externalContentStamp,
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readWebSearchApiKey,
  readWebSearchQueryAndCount,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withSelfHostedWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  assertHttpUrlTargetsPrivateNetwork,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asNonArrayRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBraveMode } from "../web-search-shared.js";

const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com";
const BRAVE_SEARCH_ENDPOINT_PATH = "/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT_PATH = "/res/v1/llm/context";
const braveHttpLogger = createSubsystemLogger("brave/http");
type BraveEndpointMode = "selfHosted" | "strict";

type BraveLlmContextResponse = {
  grounding: { generic?: { url: string; title: string; snippets: string[] }[] };
  sources?: Record<string, { age?: string[] }>;
};

const BRAVE_COUNTRY_CODES = new Set([
  "AR",
  "AU",
  "AT",
  "BE",
  "BR",
  "CA",
  "CL",
  "DK",
  "FI",
  "FR",
  "DE",
  "GR",
  "HK",
  "IN",
  "ID",
  "IT",
  "JP",
  "KR",
  "MY",
  "MX",
  "NL",
  "NZ",
  "NO",
  "CN",
  "PL",
  "PT",
  "PH",
  "RU",
  "SA",
  "ZA",
  "ES",
  "SE",
  "CH",
  "TW",
  "TR",
  "GB",
  "US",
  "ALL",
]);

const BRAVE_SEARCH_LANG_CODES = new Set([
  "ar",
  "eu",
  "bn",
  "bg",
  "ca",
  "zh-hans",
  "zh-hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "en-gb",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "is",
  "it",
  "jp",
  "kn",
  "ko",
  "lv",
  "lt",
  "ms",
  "ml",
  "mr",
  "nb",
  "pl",
  "pt-br",
  "pt-pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
]);

const BRAVE_SEARCH_LANG_ALIASES: Record<string, string> = {
  ja: "jp",
  zh: "zh-hans",
  "zh-cn": "zh-hans",
  "zh-hk": "zh-hant",
  "zh-sg": "zh-hans",
  "zh-tw": "zh-hant",
};

const BRAVE_UI_LANG_LOCALE = /^([a-z]{2})-([a-z]{2})$/i;

function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  const lower = normalizeLowercaseStringOrEmpty(value);
  const canonical = BRAVE_SEARCH_LANG_ALIASES[lower] ?? lower;
  return BRAVE_SEARCH_LANG_CODES.has(canonical) ? canonical : undefined;
}

function normalizeBraveUiLang(value: string | undefined): string | undefined {
  const match = normalizeOptionalString(value)?.match(BRAVE_UI_LANG_LOCALE);
  if (!match) {
    return undefined;
  }
  const [, language, region] = match;
  if (!language || !region) {
    return undefined;
  }
  return `${normalizeLowercaseStringOrEmpty(language)}-${region.toUpperCase()}`;
}

type BraveSearchResponse = {
  web?: {
    results?: Array<{ title?: string; url?: string; description?: string; page_age?: string }>;
  };
};

function logBraveHttp(
  diagnosticsEnabled: boolean,
  event: string,
  meta?: Record<string, unknown>,
): void {
  if (!diagnosticsEnabled) {
    return;
  }
  braveHttpLogger.info(`brave http ${event}`, meta);
}

async function braveEndpointTargetsPrivateNetwork(
  url: URL,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      signal,
      policy: {
        allowPrivateNetwork: true,
        allowRfc2544BenchmarkRange: true,
      },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function validateBraveBaseUrl(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<BraveEndpointMode> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Brave Search base URL must be a valid http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Brave Search base URL must use http:// or https://.");
  }

  if (parsed.protocol === "http:") {
    await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
      signal,
      dangerouslyAllowPrivateNetwork: true,
      errorMessage:
        "Brave Search HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    });
    return "selfHosted";
  }

  return (await braveEndpointTargetsPrivateNetwork(parsed, signal)) ? "selfHosted" : "strict";
}

export async function executeBraveSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  options?: {
    diagnosticsEnabled?: boolean;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const apiKey = readWebSearchApiKey(
    searchConfig?.apiKey,
    "plugins.entries.brave.config.webSearch.apiKey",
    ["BRAVE_API_KEY"],
  );
  if (!apiKey) {
    return {
      error: "missing_brave_api_key",
      message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const braveConfig = asNonArrayRecord(searchConfig?.brave);
  const braveMode = resolveBraveMode(braveConfig);
  const configuredBraveBaseUrl = readConfiguredSecretString(
    braveConfig?.baseUrl,
    "plugins.entries.brave.config.webSearch.baseUrl",
  );
  const braveBaseUrl = configuredBraveBaseUrl?.replace(/\/+$/u, "") || DEFAULT_BRAVE_BASE_URL;
  // One deadline owns classification, transport, response consumption, and cache publication.
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: resolveSearchTimeoutSeconds(searchConfig) * 1_000,
    signal: options?.signal,
    operation: "brave.web_search",
    url: braveBaseUrl,
  });
  try {
    signal?.throwIfAborted();
    const braveEndpointMode = await validateBraveBaseUrl(braveBaseUrl, signal);
    signal?.throwIfAborted();
    const { query, count } = readWebSearchQueryAndCount(args, searchConfig);
    const rawCountry = normalizeOptionalString(readStringParam(args, "country"));
    const canonicalCountry = rawCountry?.toUpperCase();
    const country = canonicalCountry
      ? BRAVE_COUNTRY_CODES.has(canonicalCountry)
        ? canonicalCountry
        : "ALL"
      : undefined;
    const language = readStringParam(args, "language");
    const search_lang = readStringParam(args, "search_lang");
    const ui_lang = readStringParam(args, "ui_lang");
    const rawSearchLang = normalizeOptionalString(search_lang || language);
    const rawUiLang = normalizeOptionalString(ui_lang);
    let searchLangCandidate = rawSearchLang;
    let uiLangCandidate = rawUiLang;
    if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
      searchLangCandidate = rawUiLang;
      uiLangCandidate = rawSearchLang;
    }
    const normalizedSearchLang = normalizeBraveSearchLang(searchLangCandidate);
    if (searchLangCandidate && !normalizedSearchLang) {
      return {
        error: "invalid_search_lang",
        message:
          "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    const normalizedUiLang = normalizeBraveUiLang(uiLangCandidate);
    if (uiLangCandidate && !normalizedUiLang) {
      return {
        error: "invalid_ui_lang",
        message: "ui_lang must be a language-region locale like 'en-US'.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (normalizedUiLang && braveMode === "llm-context") {
      return {
        error: "unsupported_ui_lang",
        message:
          "ui_lang is not supported by Brave llm-context mode. Remove ui_lang or use Brave web mode for locale-based UI hints.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }

    const rawFreshness = readStringParam(args, "freshness");
    const rawDateAfter = readStringParam(args, "date_after");
    const rawDateBefore = readStringParam(args, "date_before");
    const parsedTimeFilters = parseWebSearchTimeFilters({
      rawDateAfter,
      rawDateBefore,
      rawFreshness,
      freshnessProvider: "brave",
      invalidFreshnessMessage: "freshness must be day, week, month, or year.",
      invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
      invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
      invalidDateRangeMessage: "date_after must be before date_before.",
    });
    if ("error" in parsedTimeFilters) {
      return parsedTimeFilters;
    }

    const { freshness, dateAfter, dateBefore } = parsedTimeFilters;
    if (braveMode === "llm-context") {
      const today = new Date().toISOString().slice(0, 10);
      if (dateAfter && !dateBefore && dateAfter > today) {
        return {
          error: "invalid_date_range",
          message: "date_after cannot be in the future for Brave llm-context mode.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if (dateBefore && !dateAfter) {
        return {
          error: "unsupported_date_filter",
          message:
            "Brave llm-context mode requires date_after when date_before is set. Use a bounded date range or freshness.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
    }
    const llmContextDateEnd =
      braveMode === "llm-context" && dateAfter
        ? (dateBefore ?? new Date().toISOString().slice(0, 10))
        : dateBefore;
    const requestedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
    const cacheKey = buildSearchCacheKey([
      "brave",
      sha256Hex(apiKey),
      braveMode,
      braveBaseUrl,
      query,
      requestedCount,
      country,
      normalizedSearchLang,
      ...(braveMode === "web" ? [normalizedUiLang] : []),
      freshness,
      dateAfter,
      llmContextDateEnd,
    ]);
    const diagnosticsEnabled = options?.diagnosticsEnabled === true;
    const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
    const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
    if (cached) {
      logBraveHttp(diagnosticsEnabled, "cache hit", { mode: braveMode });
      return cached;
    }
    logBraveHttp(diagnosticsEnabled, "cache miss", { mode: braveMode });

    const start = Date.now();
    const url = new URL(braveBaseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}${
      braveMode === "llm-context" ? BRAVE_LLM_CONTEXT_ENDPOINT_PATH : BRAVE_SEARCH_ENDPOINT_PATH
    }`;
    url.search = "";
    url.searchParams.set("q", query);
    if (country) {
      url.searchParams.set("country", country);
    }
    if (normalizedSearchLang) {
      url.searchParams.set("search_lang", normalizedSearchLang);
    }
    if (freshness) {
      url.searchParams.set("freshness", freshness);
    } else if (dateAfter && dateBefore) {
      url.searchParams.set("freshness", `${dateAfter}to${dateBefore}`);
    } else if (dateAfter) {
      url.searchParams.set("freshness", `${dateAfter}to${new Date().toISOString().slice(0, 10)}`);
    } else if (braveMode === "web" && dateBefore) {
      url.searchParams.set("freshness", `1970-01-01to${dateBefore}`);
    }
    if (braveMode === "web") {
      url.searchParams.set("count", String(requestedCount));
      if (normalizedUiLang) {
        url.searchParams.set("ui_lang", normalizedUiLang);
      }
    }
    logBraveHttp(diagnosticsEnabled, "request", {
      mode: braveMode,
      endpoint: `${url.origin}${url.pathname}`,
      count: requestedCount,
    });
    const requestStartedAt = Date.now();
    const withEndpoint =
      braveEndpointMode === "selfHosted"
        ? withSelfHostedWebToolsEndpoint
        : withTrustedWebToolsEndpoint;
    const response = await withEndpoint(
      {
        url: url.toString(),
        signal,
        init: {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        },
      },
      async ({ response: httpResponse }) => {
        logBraveHttp(diagnosticsEnabled, "response", {
          mode: braveMode,
          status: httpResponse.status,
          ok: httpResponse.ok,
          durationMs: Date.now() - requestStartedAt,
        });
        const errorLabel =
          braveMode === "llm-context" ? "Brave LLM Context API error" : "Brave Search API error";
        await assertOkOrThrowProviderError(httpResponse, errorLabel);
        if (braveMode === "llm-context") {
          const data = await readProviderJsonResponse<BraveLlmContextResponse>(
            httpResponse,
            errorLabel,
          );
          const genericResults = Array.isArray(data.grounding?.generic)
            ? data.grounding.generic
            : [];
          return {
            mode: "llm-context" as const,
            results: genericResults.slice(0, requestedCount).map((entry) => ({
              url: entry.url ?? "",
              title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
              snippets: (entry.snippets ?? [])
                .filter((snippet) => typeof snippet === "string" && snippet.length > 0)
                .map((snippet) => wrapWebContent(snippet, "web_search")),
              siteName: resolveSiteName(entry.url) || undefined,
              // Brave's fixed age slots contain timestamp (3), date (1), and relative age (2).
              // Only the absolute forms belong in published; never infer a date from recency.
              published:
                data.sources?.[entry.url]?.age?.[3] ||
                data.sources?.[entry.url]?.age?.[1] ||
                undefined,
            })),
            sources: data.sources,
          };
        }
        const data = await readProviderJsonResponse<BraveSearchResponse>(httpResponse, errorLabel);
        const results = Array.isArray(data.web?.results) ? data.web.results : [];
        return {
          mode: "web" as const,
          results: results.slice(0, requestedCount).map((entry) => {
            const description = entry.description ?? "";
            const title = entry.title ?? "";
            const resultUrl = entry.url ?? "";
            return {
              title: title ? wrapWebContent(title, "web_search") : "",
              url: resultUrl,
              description: description ? wrapWebContent(description, "web_search") : "",
              published: entry.page_age || undefined,
              siteName: resolveSiteName(resultUrl) || undefined,
            };
          }),
        };
      },
    );
    // A completed upstream response must not write cache state after its caller aborts.
    signal?.throwIfAborted();
    const results = response.results;
    const payload = {
      query,
      provider: "brave",
      ...(response.mode === "llm-context" ? { mode: response.mode } : {}),
      count: results.length,
      tookMs: Date.now() - start,
      externalContent: externalContentStamp("brave"),
      results,
      ...(response.mode === "llm-context" ? { sources: response.sources } : {}),
    };
    writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
    logBraveHttp(diagnosticsEnabled, "cache write", {
      mode: response.mode,
      ttlMs: cacheTtlMs,
      count: results.length,
    });
    return payload;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    cleanup();
  }
}
