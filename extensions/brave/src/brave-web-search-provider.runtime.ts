import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  MAX_SEARCH_COUNT,
  parseWebSearchTimeFilters,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
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
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBraveMode } from "../web-search-shared.js";
import {
  type BraveLlmContextResponse,
  mapBraveLlmContextResults,
  normalizeBraveCountry,
  normalizeBraveLanguageParams,
} from "./brave-web-search-provider.shared.js";

const DEFAULT_BRAVE_BASE_URL = "https://api.search.brave.com";
const BRAVE_SEARCH_ENDPOINT_PATH = "/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT_PATH = "/res/v1/llm/context";
const braveHttpLogger = createSubsystemLogger("brave/http");
type BraveEndpointMode = "selfHosted" | "strict";
type BraveSearchMode = "llm-context" | "web";

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

function resolveBraveApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(
      searchConfig?.apiKey,
      "plugins.entries.brave.config.webSearch.apiKey",
    ) ?? readProviderEnvValue(["BRAVE_API_KEY"])
  );
}

function resolveBraveBaseUrl(braveConfig: { baseUrl?: unknown } | undefined): string {
  const configured = readConfiguredSecretString(
    braveConfig?.baseUrl,
    "plugins.entries.brave.config.webSearch.baseUrl",
  );
  return configured?.replace(/\/+$/u, "") || DEFAULT_BRAVE_BASE_URL;
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

async function runBraveSearch(params: {
  baseUrl: string;
  endpointMode: BraveEndpointMode;
  apiKey: string;
  diagnosticsEnabled: boolean;
  signal?: AbortSignal;
  mode: BraveSearchMode;
  query: string;
  count: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}) {
  const url = new URL(params.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}${
    params.mode === "llm-context" ? BRAVE_LLM_CONTEXT_ENDPOINT_PATH : BRAVE_SEARCH_ENDPOINT_PATH
  }`;
  url.search = "";
  url.searchParams.set("q", params.query);
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  } else if (params.mode === "web" && params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }
  if (params.mode === "web") {
    url.searchParams.set("count", String(params.count));
    if (params.ui_lang) {
      url.searchParams.set("ui_lang", params.ui_lang);
    }
  }
  logBraveHttp(params.diagnosticsEnabled, "request", {
    mode: params.mode,
    url: url.toString(),
    query: url.searchParams.get("q") ?? "",
    params: Object.fromEntries(url.searchParams.entries()),
  });
  const startedAt = Date.now();
  const withEndpoint =
    params.endpointMode === "selfHosted"
      ? withSelfHostedWebToolsEndpoint
      : withTrustedWebToolsEndpoint;
  return withEndpoint(
    {
      url: url.toString(),
      signal: params.signal,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async ({ response }) => {
      logBraveHttp(params.diagnosticsEnabled, "response", {
        mode: params.mode,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });
      const errorLabel =
        params.mode === "llm-context" ? "Brave LLM Context API error" : "Brave Search API error";
      await assertOkOrThrowProviderError(response, errorLabel);
      if (params.mode === "llm-context") {
        const data = await readProviderJsonResponse<BraveLlmContextResponse>(response, errorLabel);
        return {
          mode: "llm-context" as const,
          results: mapBraveLlmContextResults(data),
          sources: data.sources,
        };
      }
      const data = await readProviderJsonResponse<BraveSearchResponse>(response, errorLabel);
      const results = Array.isArray(data.web?.results) ? data.web.results : [];
      return {
        mode: "web" as const,
        results: results.slice(0, params.count).map((entry) => {
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
}

export async function executeBraveSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  options?: {
    diagnosticsEnabled?: boolean;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const apiKey = resolveBraveApiKey(searchConfig);
  if (!apiKey) {
    return {
      error: "missing_brave_api_key",
      message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const braveConfig = asNonArrayRecord(searchConfig?.brave);
  const braveMode = resolveBraveMode(braveConfig);
  const braveBaseUrl = resolveBraveBaseUrl(braveConfig);
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
    const query = readStringParam(args, "query", { required: true });
    const count =
      readPositiveIntegerParam(args, "count", {
        max: MAX_SEARCH_COUNT,
        message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
      }) ??
      searchConfig?.maxResults ??
      undefined;
    const country = normalizeBraveCountry(readStringParam(args, "country"));
    const language = readStringParam(args, "language");
    const search_lang = readStringParam(args, "search_lang");
    const ui_lang = readStringParam(args, "ui_lang");
    const normalizedLanguage = normalizeBraveLanguageParams({
      search_lang: search_lang || language,
      ui_lang,
    });

    if (normalizedLanguage.invalidField === "search_lang") {
      return {
        error: "invalid_search_lang",
        message:
          "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (normalizedLanguage.invalidField === "ui_lang") {
      return {
        error: "invalid_ui_lang",
        message: "ui_lang must be a language-region locale like 'en-US'.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (normalizedLanguage.ui_lang && braveMode === "llm-context") {
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
      braveMode,
      braveBaseUrl,
      query,
      requestedCount,
      country,
      normalizedLanguage.search_lang,
      ...(braveMode === "web" ? [normalizedLanguage.ui_lang] : []),
      freshness,
      dateAfter,
      llmContextDateEnd,
    ]);
    const diagnosticsEnabled = options?.diagnosticsEnabled === true;
    const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);
    const cached = readCachedSearchPayload(cacheKey, cacheTtlMs);
    if (cached) {
      logBraveHttp(diagnosticsEnabled, "cache hit", { mode: braveMode, query, cacheKey });
      return cached;
    }
    logBraveHttp(diagnosticsEnabled, "cache miss", { mode: braveMode, query, cacheKey });

    const start = Date.now();
    const response = await runBraveSearch({
      baseUrl: braveBaseUrl,
      endpointMode: braveEndpointMode,
      query,
      apiKey,
      diagnosticsEnabled,
      signal,
      country: country ?? undefined,
      search_lang: normalizedLanguage.search_lang,
      freshness,
      dateAfter,
      dateBefore,
      mode: braveMode,
      count: requestedCount,
      ui_lang: normalizedLanguage.ui_lang,
    });
    // A completed upstream response must not write cache state after its caller aborts.
    signal?.throwIfAborted();
    const results =
      response.mode === "llm-context"
        ? response.results.slice(0, requestedCount).map((entry) => ({
            title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
            url: entry.url,
            snippets: entry.snippets.map((snippet) => wrapWebContent(snippet, "web_search")),
            siteName: entry.siteName,
            published: entry.published,
          }))
        : response.results;
    const payload = {
      query,
      provider: "brave",
      ...(response.mode === "llm-context" ? { mode: response.mode } : {}),
      count: results.length,
      tookMs: Date.now() - start,
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: "brave",
        wrapped: true,
      },
      results,
      ...(response.mode === "llm-context" ? { sources: response.sources } : {}),
    };
    writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
    logBraveHttp(diagnosticsEnabled, "cache write", {
      mode: response.mode,
      query,
      cacheKey,
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
