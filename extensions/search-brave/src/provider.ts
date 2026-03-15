import {
  CacheEntry,
  createLegacySearchProviderMetadata,
  createMissingSearchKeyPayload,
  formatCliCommand,
  normalizeCacheKey,
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
  readCache,
  readResponseText,
  readSearchProviderApiKeyValue,
  resolveSearchConfig,
  resolveSiteName,
  type OpenClawConfig,
  type SearchProviderContext,
  type SearchProviderErrorResult,
  type SearchProviderExecutionResult,
  type SearchProviderLegacyUiMetadata,
  type SearchProviderPlugin,
  type SearchProviderRequest,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/web-search";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";

const BRAVE_SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;
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

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type BraveLlmContextResult = { url: string; title: string; snippets: string[] };
type BraveLlmContextResponse = {
  grounding: { generic?: BraveLlmContextResult[] };
  sources?: { url?: string; hostname?: string; date?: string }[];
};

type BraveConfig = {
  mode?: string;
};

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

function resolveBraveConfig(search?: WebSearchConfig): BraveConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const brave = "brave" in search ? search.brave : undefined;
  return brave && typeof brave === "object" ? (brave as BraveConfig) : {};
}

function resolveBraveMode(brave: BraveConfig): "web" | "llm-context" {
  return brave.mode === "llm-context" ? "llm-context" : "web";
}

function resolveBraveApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfigRaw = search
    ? normalizeResolvedSecretInputString({
        value: readSearchProviderApiKeyValue(search as Record<string, unknown>, "brave"),
        path: "tools.web.search.apiKey",
      })
    : undefined;
  const fromConfig = normalizeSecretInput(fromConfigRaw);
  const fromEnv = normalizeSecretInput(process.env.BRAVE_API_KEY);
  return fromConfig || fromEnv || undefined;
}

function normalizeBraveSearchLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const canonical = BRAVE_SEARCH_LANG_ALIASES[trimmed.toLowerCase()] ?? trimmed.toLowerCase();
  if (!BRAVE_SEARCH_LANG_CODES.has(canonical)) {
    return undefined;
  }
  return canonical;
}

function normalizeBraveUiLang(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(BRAVE_UI_LANG_LOCALE);
  if (!match) {
    return undefined;
  }
  const [, language, region] = match;
  return `${language.toLowerCase()}-${region.toUpperCase()}`;
}

function normalizeBraveLanguageParams(params: { search_lang?: string; ui_lang?: string }): {
  search_lang?: string;
  ui_lang?: string;
  invalidField?: "search_lang" | "ui_lang";
} {
  const rawSearchLang = params.search_lang?.trim() || undefined;
  const rawUiLang = params.ui_lang?.trim() || undefined;
  let searchLangCandidate = rawSearchLang;
  let uiLangCandidate = rawUiLang;

  if (normalizeBraveUiLang(rawSearchLang) && normalizeBraveSearchLang(rawUiLang)) {
    searchLangCandidate = rawUiLang;
    uiLangCandidate = rawSearchLang;
  }

  const search_lang = normalizeBraveSearchLang(searchLangCandidate);
  if (searchLangCandidate && !search_lang) {
    return { invalidField: "search_lang" };
  }

  const ui_lang = normalizeBraveUiLang(uiLangCandidate);
  if (uiLangCandidate && !ui_lang) {
    return { invalidField: "ui_lang" };
  }

  return { search_lang, ui_lang };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }
  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (match) {
    const [, start, end] = match;
    if (isValidIsoDate(start) && isValidIsoDate(end) && start <= end) {
      return `${start}to${end}`;
    }
  }
  return undefined;
}

function buildBraveCacheIdentity(params: {
  query: string;
  count: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  braveMode: "web" | "llm-context";
}): string {
  return [
    params.query,
    params.count,
    params.country || "default",
    params.search_lang || "default",
    params.ui_lang || "default",
    params.freshness || "default",
    params.dateAfter || "default",
    params.dateBefore || "default",
    params.braveMode,
  ].join(":");
}

async function throwBraveApiError(res: Response, label: string): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  const detail = detailResult.text;
  throw new Error(`${label} API error (${res.status}): ${detail || res.statusText}`);
}

function mapBraveLlmContextResults(
  data: BraveLlmContextResponse,
): { url: string; title: string; snippets: string[]; siteName?: string }[] {
  const genericResults = Array.isArray(data.grounding?.generic) ? data.grounding.generic : [];
  return genericResults.map((entry) => ({
    url: entry.url ?? "",
    title: entry.title ?? "",
    snippets: (entry.snippets ?? []).filter((s) => typeof s === "string" && s.length > 0),
    siteName: resolveSiteName(entry.url) || undefined,
  }));
}

async function runBraveLlmContextSearch(params: {
  query: string;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
}) {
  const url = new URL(BRAVE_LLM_CONTEXT_ENDPOINT);
  url.searchParams.set("q", params.query);
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  return withTrustedWebToolsEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwBraveApiError(response, "Brave LLM Context");
      }
      const data = (await response.json()) as BraveLlmContextResponse;
      return { results: mapBraveLlmContextResults(data), sources: data.sources };
    },
  );
}

async function runBraveWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
}) {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
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
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }

  return withTrustedWebToolsEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwBraveApiError(response, "Brave Search");
      }
      const data = (await response.json()) as BraveSearchResponse;
      const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
      return results.map((entry) => {
        const description = entry.description ?? "";
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.age || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

export const BRAVE_SEARCH_PROVIDER_METADATA: SearchProviderLegacyUiMetadata =
  createLegacySearchProviderMetadata({
    provider: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    envKeys: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    apiKeyConfigPath: "tools.web.search.apiKey",
  });

export function createBundledBraveSearchProvider(): SearchProviderPlugin {
  return {
    id: "brave",
    name: BRAVE_SEARCH_PROVIDER_METADATA.label,
    description:
      "Search the web using Brave Search. Supports web and llm-context modes, region-specific search, and localized search parameters.",
    pluginOwnedExecution: true,
    docsUrl: BRAVE_SEARCH_PROVIDER_METADATA.signupUrl,
    legacyConfig: BRAVE_SEARCH_PROVIDER_METADATA,
    isAvailable: (config) => {
      const search = config?.tools?.web?.search;
      return Boolean(
        resolveBraveApiKey(resolveSearchConfig<WebSearchConfig>(search as Record<string, unknown>)),
      );
    },
    search: async (request, ctx): Promise<SearchProviderExecutionResult> => {
      const search = resolveSearchConfig<WebSearchConfig>(request.providerConfig);
      const braveConfig = resolveBraveConfig(search);
      const braveMode = resolveBraveMode(braveConfig);
      const apiKey = resolveBraveApiKey(search);

      if (!apiKey) {
        return createMissingSearchKeyPayload(
          "missing_brave_api_key",
          `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
        );
      }

      const normalizedLanguageParams = normalizeBraveLanguageParams({
        search_lang: request.search_lang || request.language,
        ui_lang: request.ui_lang,
      });
      if (normalizedLanguageParams.invalidField === "search_lang") {
        return {
          error: "invalid_search_lang",
          message:
            "search_lang must be a Brave-supported language code like 'en', 'en-gb', 'zh-hans', or 'zh-hant'.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if (normalizedLanguageParams.invalidField === "ui_lang") {
        return {
          error: "invalid_ui_lang",
          message: "ui_lang must be a language-region locale like 'en-US'.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if (normalizedLanguageParams.ui_lang && braveMode === "llm-context") {
        return {
          error: "unsupported_ui_lang",
          message:
            "ui_lang is not supported by Brave llm-context mode. Remove ui_lang or use Brave web mode for locale-based UI hints.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if (request.freshness && braveMode === "llm-context") {
        return {
          error: "unsupported_freshness",
          message:
            "freshness filtering is not supported by Brave llm-context mode. Remove freshness or use Brave web mode.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      const normalizedFreshness = request.freshness
        ? normalizeFreshness(request.freshness)
        : undefined;
      if (request.freshness && !normalizedFreshness) {
        return {
          error: "invalid_freshness",
          message: "freshness must be day, week, month, or year.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if ((request.dateAfter || request.dateBefore) && braveMode === "llm-context") {
        return {
          error: "unsupported_date_filter",
          message:
            "date_after/date_before filtering is not supported by Brave llm-context mode. Use Brave web mode for date filters.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const cacheKey = normalizeCacheKey(
        `brave:${buildBraveCacheIdentity({
          query: request.query,
          count: request.count,
          country: request.country,
          search_lang: normalizedLanguageParams.search_lang,
          ui_lang: normalizedLanguageParams.ui_lang,
          freshness: normalizedFreshness,
          dateAfter: request.dateAfter,
          dateBefore: request.dateBefore,
          braveMode,
        })}`,
      );
      const cached = readCache(BRAVE_SEARCH_CACHE, cacheKey);
      if (cached) {
        return { ...cached.value, cached: true } as Record<
          string,
          unknown
        > as SearchProviderExecutionResult;
      }

      const startedAt = Date.now();
      if (braveMode === "llm-context") {
        const { results, sources } = await runBraveLlmContextSearch({
          query: request.query,
          apiKey,
          timeoutSeconds: ctx.timeoutSeconds,
          country: request.country,
          search_lang: normalizedLanguageParams.search_lang,
          freshness: normalizedFreshness,
        });
        const mappedResults = results.map(
          (entry: { title: string; url: string; snippets: string[]; siteName?: string }) => ({
            title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
            url: entry.url,
            snippets: entry.snippets.map((s: string) => wrapWebContent(s, "web_search")),
            siteName: entry.siteName,
          }),
        );
        const payload = {
          query: request.query,
          provider: "brave",
          mode: "llm-context" as const,
          count: mappedResults.length,
          tookMs: Date.now() - startedAt,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "brave",
            wrapped: true,
          },
          results: mappedResults,
          sources,
        };
        writeCache(BRAVE_SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
        return payload as Record<string, unknown> as SearchProviderExecutionResult;
      }

      const results = await runBraveWebSearch({
        query: request.query,
        count: request.count,
        apiKey,
        timeoutSeconds: ctx.timeoutSeconds,
        country: request.country,
        search_lang: normalizedLanguageParams.search_lang,
        ui_lang: normalizedLanguageParams.ui_lang,
        freshness: normalizedFreshness,
        dateAfter: request.dateAfter,
        dateBefore: request.dateBefore,
      });
      const payload = {
        query: request.query,
        provider: "brave",
        count: results.length,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "brave",
          wrapped: true,
        },
        results,
      };
      writeCache(BRAVE_SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
      return payload as Record<string, unknown> as SearchProviderExecutionResult;
    },
  };
}

export const __testing = {
  resolveBraveApiKey,
  resolveBraveMode,
  normalizeBraveLanguageParams,
  normalizeFreshness,
  clearSearchProviderCaches() {
    BRAVE_SEARCH_CACHE.clear();
  },
};
