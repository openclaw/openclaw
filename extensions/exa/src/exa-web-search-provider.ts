import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  enablePluginInConfig,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  normalizeToIsoDate,
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
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_SEARCH_TYPES = ["auto", "keyword", "neural"] as const;
const EXA_FRESHNESS_VALUES = ["day", "week", "month", "year"] as const;

type ExaConfig = {
  apiKey?: string;
};

type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];
type ExaFreshness = (typeof EXA_FRESHNESS_VALUES)[number];

type ExaContentsArgs = {
  highlights?: boolean;
  text?: boolean;
};

type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  text?: unknown;
};

type ExaSearchResponse = {
  results?: unknown;
};

function normalizeExaFreshness(value: string | undefined): ExaFreshness | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return EXA_FRESHNESS_VALUES.includes(trimmed as ExaFreshness)
    ? (trimmed as ExaFreshness)
    : undefined;
}

function optionalStringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      description,
    }),
  );
}

function resolveExaConfig(searchConfig?: SearchConfigRecord): ExaConfig {
  const exa = searchConfig?.exa;
  return exa && typeof exa === "object" && !Array.isArray(exa) ? (exa as ExaConfig) : {};
}

function resolveExaApiKey(exa?: ExaConfig): string | undefined {
  return (
    readConfiguredSecretString(exa?.apiKey, "tools.web.search.exa.apiKey") ??
    readProviderEnvValue(["EXA_API_KEY"])
  );
}

function resolveExaDescription(result: ExaSearchResult): string {
  const highlights = result.highlights;
  if (Array.isArray(highlights)) {
    const highlightText = highlights
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (highlightText) {
      return highlightText;
    }
  }
  return typeof result.text === "string" ? result.text.trim() : "";
}

function normalizeExaResults(payload: unknown): ExaSearchResult[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const results = (payload as ExaSearchResponse).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter((entry): entry is ExaSearchResult =>
    Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

function resolveFreshnessStartDate(freshness: ExaFreshness): string {
  const now = new Date();
  if (freshness === "day") {
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString();
  }
  if (freshness === "week") {
    now.setUTCDate(now.getUTCDate() - 7);
    return now.toISOString();
  }
  if (freshness === "month") {
    const currentDay = now.getUTCDate();
    now.setUTCDate(1);
    now.setUTCMonth(now.getUTCMonth() - 1);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    now.setUTCDate(Math.min(currentDay, lastDayOfTargetMonth));
    return now.toISOString();
  }
  now.setUTCFullYear(now.getUTCFullYear() - 1);
  return now.toISOString();
}

async function runExaSearch(params: {
  apiKey: string;
  query: string;
  count: number;
  freshness?: ExaFreshness;
  dateAfter?: string;
  dateBefore?: string;
  type: ExaSearchType;
  contents?: ExaContentsArgs;
  timeoutSeconds: number;
}): Promise<ExaSearchResult[]> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.count,
    type: params.type,
    contents: params.contents ?? { highlights: true },
  };

  if (params.dateAfter) {
    body.startPublishedDate = params.dateAfter;
  } else if (params.freshness) {
    body.startPublishedDate = resolveFreshnessStartDate(params.freshness);
  }
  if (params.dateBefore) {
    body.endPublishedDate = params.dateBefore;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: EXA_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
          "x-exa-integration": "openclaw",
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Exa API error (${res.status}): ${detail || res.statusText}`);
      }
      try {
        return normalizeExaResults(await res.json());
      } catch (error) {
        throw new Error(`Exa API returned invalid JSON: ${String(error)}`, { cause: error });
      }
    },
  );
}

function createExaSchema() {
  return Type.Object(
    {
      query: Type.String({ description: "Search query string." }),
      count: Type.Optional(
        Type.Number({
          description: "Number of results to return (1-10).",
          minimum: 1,
          maximum: MAX_SEARCH_COUNT,
        }),
      ),
      freshness: optionalStringEnum(
        EXA_FRESHNESS_VALUES,
        'Filter by time: "day", "week", "month", or "year".',
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
      type: optionalStringEnum(
        EXA_SEARCH_TYPES,
        'Exa search mode: "auto", "keyword", or "neural".',
      ),
      contents: Type.Optional(
        Type.Object(
          {
            highlights: Type.Optional(
              Type.Boolean({ description: "Include Exa highlights in results." }),
            ),
            text: Type.Optional(Type.Boolean({ description: "Include full text in results." })),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  );
}

function missingExaKeyPayload() {
  return {
    error: "missing_exa_api_key",
    message:
      "web_search (exa) needs an Exa API key. Set EXA_API_KEY in the Gateway environment, or configure tools.web.search.exa.apiKey.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createExaToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Exa AI. Supports neural or keyword search, publication date filters, and optional highlights or text extraction.",
    parameters: createExaSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const exaConfig = resolveExaConfig(searchConfig);
      const apiKey = resolveExaApiKey(exaConfig);
      if (!apiKey) {
        return missingExaKeyPayload();
      }

      const query = readStringParam(params, "query", { required: true });
      const rawType = readStringParam(params, "type");
      const type: ExaSearchType =
        rawType === "keyword" || rawType === "neural" || rawType === "auto" ? rawType : "auto";
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const rawFreshness = readStringParam(params, "freshness");
      const freshness = normalizeExaFreshness(rawFreshness);
      if (rawFreshness && !freshness) {
        return {
          error: "invalid_freshness",
          message: 'freshness must be one of "day", "week", "month", or "year".',
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");
      if (freshness && (rawDateAfter || rawDateBefore)) {
        return {
          error: "conflicting_time_filters",
          message:
            "freshness cannot be combined with date_after or date_before. Use one time-filter mode.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined;
      if (rawDateAfter && !dateAfter) {
        return {
          error: "invalid_date",
          message: "date_after must be YYYY-MM-DD format.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined;
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
          message: "date_after must be earlier than or equal to date_before.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const rawContents = params.contents;
      const contents =
        rawContents && typeof rawContents === "object" && !Array.isArray(rawContents)
          ? (rawContents as ExaContentsArgs)
          : undefined;

      const cacheKey = buildSearchCacheKey([
        "exa",
        type,
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        freshness,
        dateAfter,
        dateBefore,
        contents?.highlights,
        contents?.text,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const results = await runExaSearch({
        apiKey,
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        freshness,
        dateAfter,
        dateBefore,
        type,
        contents,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });

      const payload = {
        query,
        provider: "exa",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "exa",
          wrapped: true,
        },
        results: results.map((entry) => {
          const title = typeof entry.title === "string" ? entry.title : "";
          const url = typeof entry.url === "string" ? entry.url : "";
          const description = resolveExaDescription(entry);
          const published =
            typeof entry.publishedDate === "string" && entry.publishedDate
              ? entry.publishedDate
              : undefined;
          return {
            title: title ? wrapWebContent(title, "web_search") : "",
            url,
            description: description ? wrapWebContent(description, "web_search") : "",
            published,
            siteName: resolveSiteName(url) || undefined,
          };
        }),
      };

      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createExaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "exa",
    label: "Exa Search",
    hint: "Neural + keyword search with date filters and content extraction",
    credentialLabel: "Exa API key",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    signupUrl: "https://exa.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 65,
    credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.exa.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "exa"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "exa", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "exa")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "exa", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "exa").config,
    createTool: (ctx) =>
      createExaToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "exa",
          resolveProviderWebSearchPluginConfig(ctx.config, "exa"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  normalizeExaResults,
  resolveExaApiKey,
  resolveExaConfig,
  resolveExaDescription,
  resolveFreshnessStartDate,
} as const;
