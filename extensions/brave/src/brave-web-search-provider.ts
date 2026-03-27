import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
  mergeScopedSearchConfig,
  normalizeFreshness,
  parseIsoDateRange,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setTopLevelCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_LLM_CONTEXT_ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
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

type BraveConfig = {
  mode?: string;
};

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

function resolveBraveConfig(searchConfig?: SearchConfigRecord): BraveConfig {
  const brave = searchConfig?.brave;
  return brave && typeof brave === "object" && !Array.isArray(brave) ? (brave as BraveConfig) : {};
}

function resolveBraveMode(brave?: BraveConfig): "web" | "llm-context" {
  return brave?.mode === "llm-context" ? "llm-context" : "web";
}

function resolveBraveApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["BRAVE_API_KEY"])
  );
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
}): Promise<{
  results: Array<{
    url: string;
    title: string;
    snippets: string[];
    siteName?: string;
  }>;
  sources?: BraveLlmContextResponse["sources"];
}> {
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

  return withTrustedWebSearchEndpoint(
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
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Brave LLM Context API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as BraveLlmContextResponse;
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
}): Promise<Array<Record<string, unknown>>> {
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

  return withTrustedWebSearchEndpoint(
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
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
      }

      const data = (await res.json()) as BraveSearchResponse;
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

function createBraveSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(
      Type.String({
        description:
          "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description: "Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description: "Only results published before this date (YYYY-MM-DD).",
      }),
    ),
    search_lang: Type.Optional(
      Type.String({
        description:
          "Brave language code for search results (e.g., 'en', 'de', 'en-gb', 'zh-hans', 'zh-hant', 'pt-br').",
      }),
    ),
    ui_lang: Type.Optional(
      Type.String({
        description:
          "Locale code for UI elements in language-region format (e.g., 'en-US', 'de-DE', 'fr-FR', 'tr-TR'). Must include region subtag.",
      }),
    ),
  });
}

function missingBraveKeyPayload() {
  return {
    error: "missing_brave_api_key",
    message: `web_search (brave) needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createBraveToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const braveConfig = resolveBraveConfig(searchConfig);
  const braveMode = resolveBraveMode(braveConfig);

  return {
    description:
      braveMode === "llm-context"
        ? "Search the web using Brave Search LLM Context API. Returns pre-extracted page content (text chunks, tables, code blocks) optimized for LLM grounding."
        : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
    parameters: createBraveSchema(),
    execute: async (args) => {
      const apiKey = resolveBraveApiKey(searchConfig);
      if (!apiKey) {
        return missingBraveKeyPayload();
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const country = readStringParam(params, "country");
      const language = readStringParam(params, "language");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
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

      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && braveMode === "llm-context") {
        return {
          error: "unsupported_freshness",
          message:
            "freshness filtering is not supported by Brave llm-context mode. Remove freshness or use Brave web mode.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "brave") : undefined;
      if (rawFreshness && !freshness) {
        return {
          error: "invalid_freshness",
          message: "freshness must be day, week, month, or year.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");
      if (rawFreshness && (rawDateAfter || rawDateBefore)) {
        return {
          error: "conflicting_time_filters",
          message:
            "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if ((rawDateAfter || rawDateBefore) && braveMode === "llm-context") {
        return {
          error: "unsupported_date_filter",
          message:
            "date_after/date_before filtering is not supported by Brave llm-context mode. Use Brave web mode for date filters.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      const parsedDateRange = parseIsoDateRange({
        rawDateAfter,
        rawDateBefore,
        invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
        invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
        invalidDateRangeMessage: "date_after must be before date_before.",
      });
      if ("error" in parsedDateRange) {
        return parsedDateRange;
      }
      const { dateAfter, dateBefore } = parsedDateRange;

      const cacheKey = buildSearchCacheKey([
        "brave",
        braveMode,
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        country,
        normalizedLanguage.search_lang,
        normalizedLanguage.ui_lang,
        freshness,
        dateAfter,
        dateBefore,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      if (braveMode === "llm-context") {
        const { results, sources } = await runBraveLlmContextSearch({
          query,
          apiKey,
          timeoutSeconds,
          country: country ?? undefined,
          search_lang: normalizedLanguage.search_lang,
          freshness,
        });
        const payload = {
          query,
          provider: "brave",
          mode: "llm-context" as const,
          count: results.length,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "brave",
            wrapped: true,
          },
          results: results.map((entry) => ({
            title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
            url: entry.url,
            snippets: entry.snippets.map((snippet) => wrapWebContent(snippet, "web_search")),
            siteName: entry.siteName,
          })),
          sources,
        };
        writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
        return payload;
      }

      const results = await runBraveWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds,
        country: country ?? undefined,
        search_lang: normalizedLanguage.search_lang,
        ui_lang: normalizedLanguage.ui_lang,
        freshness,
        dateAfter,
        dateBefore,
      });
      const payload = {
        query,
        provider: "brave",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "brave",
          wrapped: true,
        },
        results,
      };
      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
  };
}

export function createBraveWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "brave",
    label: "Brave Search",
    hint: "Structured results · country/language/time filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Brave Search API key",
    envVars: ["BRAVE_API_KEY"],
    placeholder: "BSA...",
    signupUrl: "https://brave.com/search/api/",
    docsUrl: "https://docs.openclaw.ai/brave-search",
    autoDetectOrder: 10,
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.brave.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "brave")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "brave", "apiKey", value);
    },
    createTool: (ctx) =>
      createBraveToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "brave",
          resolveProviderWebSearchPluginConfig(ctx.config, "brave"),
          { mirrorApiKeyToTopLevel: true },
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  normalizeFreshness,
  normalizeBraveLanguageParams,
  resolveBraveMode,
  mapBraveLlmContextResults,
} as const;
