import { Type } from "@sinclair/typebox";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  normalizeToIsoDate,
  postTrustedWebToolsJson,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const QUERIT_SEARCH_ENDPOINT = "https://api.querit.ai/v1/search";

type QueritConfig = {
  apiKey?: unknown;
};

type QueritSearchResult = {
  title?: string;
  url?: string;
  snippet?: string;
  site_name?: string;
  page_age?: string;
  site_icon?: string;
};

type QueritSearchResponse = {
  took?: string;
  error_code?: number;
  error_msg?: string;
  search_id?: number;
  query_context?: { query?: string };
  results?: { result?: QueritSearchResult[] };
};

function resolveQueritConfig(searchConfig?: SearchConfigRecord): QueritConfig {
  const querit = searchConfig?.querit;
  return querit && typeof querit === "object" && !Array.isArray(querit)
    ? (querit as QueritConfig)
    : {};
}

function resolveQueritApiKey(querit?: QueritConfig): string | undefined {
  return (
    readConfiguredSecretString(querit?.apiKey, "plugins.entries.querit.config.webSearch.apiKey") ||
    readProviderEnvValue(["QUERIT_API_KEY"]) ||
    undefined
  );
}

function extractIsoDateFromPageAge(pageAge: string): string | undefined {
  // page_age may be a full timestamp (e.g. "2025-07-20T16:00:00Z"); strip the
  // time component so normalizeToIsoDate can match the bare YYYY-MM-DD prefix.
  return normalizeToIsoDate(pageAge.split("T")[0]);
}

function mapQueritResult(entry: QueritSearchResult): Record<string, unknown> {
  const published = entry.page_age ? extractIsoDateFromPageAge(entry.page_age) : undefined;
  return {
    title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
    url: entry.url ?? "",
    snippet: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
    siteName: entry.site_name || resolveSiteName(entry.url) || undefined,
    ...(published ? { published } : {}),
  };
}

async function runQueritSearch(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  language?: string;
  timeRangeDate?: string;
}): Promise<Array<Record<string, unknown>>> {
  const filters: Record<string, unknown> = {};
  if (params.timeRangeDate) {
    filters.timeRange = { date: params.timeRangeDate };
  }
  if (params.country) {
    filters.geo = { countries: { include: [params.country] } };
  }
  if (params.language) {
    filters.languages = { include: [params.language] };
  }

  const body: Record<string, unknown> = {
    query: params.query,
    count: params.count,
  };
  if (Object.keys(filters).length > 0) {
    body.filters = filters;
  }

  return postTrustedWebToolsJson(
    {
      url: QUERIT_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      body,
      errorLabel: "Querit",
    },
    async (res) => {
      const data = (await res.json()) as QueritSearchResponse;
      if (data.error_code !== 200) {
        throw new Error(
          `Querit search failed (error_code ${data.error_code ?? "missing"}): ${data.error_msg ?? "unknown error"}`,
        );
      }
      return (data.results?.result ?? []).map(mapQueritResult);
    },
  );
}

function createQueritToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const queritConfig = resolveQueritConfig(searchConfig);

  return {
    description:
      "Search the web using Querit (querit.ai). Returns fast, multilingual structured results for LLMs.",
    parameters: Type.Object({
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
            "Full country name to filter results (e.g. 'united states', 'japan', 'germany').",
        }),
      ),
      language: Type.Optional(
        Type.String({
          description:
            "Full language name to filter results (e.g. 'english', 'french', 'spanish').",
        }),
      ),
      freshness: Type.Optional(
        Type.String({
          description:
            "Filter by relative time: 'd1' (past day), 'w1' (past week), 'm1' (past month), 'y1' (past year).",
        }),
      ),
      date_after: Type.Optional(
        Type.String({ description: "Only results published after this date (YYYY-MM-DD)." }),
      ),
      date_before: Type.Optional(
        Type.String({ description: "Only results published before this date (YYYY-MM-DD)." }),
      ),
    }),
    execute: async (args) => {
      const apiKey = resolveQueritApiKey(queritConfig);
      if (!apiKey) {
        return {
          error: "missing_querit_api_key",
          message:
            "web_search (querit) needs an API key. Set QUERIT_API_KEY in the Gateway environment, or configure plugins.entries.querit.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const country = readStringParam(params, "country");
      const language = readStringParam(params, "language");
      const rawFreshness = readStringParam(params, "freshness");
      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");

      const VALID_FRESHNESS = new Set(["d1", "w1", "m1", "y1"]);
      const freshness = rawFreshness ? rawFreshness.trim().toLowerCase() : undefined;
      if (freshness && !VALID_FRESHNESS.has(freshness)) {
        return {
          error: "invalid_freshness",
          message: "freshness must be d1 (day), w1 (week), m1 (month), or y1 (year).",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      if (freshness && (rawDateAfter || rawDateBefore)) {
        return {
          error: "conflicting_time_filters",
          message:
            "freshness and date_after/date_before cannot be used together. Use either freshness (d1/w1/m1/y1) or a date range.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined;
      const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined;
      if (rawDateAfter && !dateAfter) {
        return {
          error: "invalid_date",
          message: "date_after must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if (rawDateBefore && !dateBefore) {
        return {
          error: "invalid_date",
          message: "date_before must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }
      if (dateAfter && dateBefore && dateAfter > dateBefore) {
        return {
          error: "invalid_date_range",
          message: "date_after must be before date_before.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      // Collapse freshness or date range into the single timeRange.date filter format.
      const timeRangeDate = freshness
        ? freshness
        : dateAfter || dateBefore
          ? `${dateAfter ?? ""}to${dateBefore ?? ""}`
          : undefined;

      const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const cacheKey = buildSearchCacheKey([
        "querit",
        query,
        resolvedCount,
        country,
        language,
        timeRangeDate,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const results = await runQueritSearch({
        query,
        apiKey,
        count: resolvedCount,
        timeoutSeconds,
        country: country ?? undefined,
        language: language ?? undefined,
        timeRangeDate,
      });

      const payload = {
        query,
        provider: "querit",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "querit",
          wrapped: true,
        },
        results,
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createQueritWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "querit",
    label: "Querit Search",
    hint: "Requires Querit API key · fast multilingual results",
    credentialLabel: "Querit API key",
    envVars: ["QUERIT_API_KEY"],
    placeholder: "querit-sk-...",
    signupUrl: "https://www.querit.ai",
    autoDetectOrder: 80,
    credentialPath: "plugins.entries.querit.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.querit.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "querit"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "querit", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "querit")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "querit", "apiKey", value);
    },
    createTool: (ctx) =>
      createQueritToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "querit",
          resolveProviderWebSearchPluginConfig(ctx.config, "querit"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveQueritApiKey,
  resolveQueritConfig,
  mapQueritResult,
} as const;
