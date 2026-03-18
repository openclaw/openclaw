import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
  normalizeFreshness,
  normalizeToIsoDate,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  type OpenClawConfig,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

type ExaConfig = {
  apiKey?: unknown;
};

type ExaSearchType = "neural" | "keyword" | "auto";

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

function resolveExaConfig(config?: OpenClawConfig, searchConfig?: SearchConfigRecord): ExaConfig {
  const pluginConfig = resolveProviderWebSearchPluginConfig(config, "exa");
  if (pluginConfig) {
    return pluginConfig as ExaConfig;
  }
  const scoped = (searchConfig as Record<string, unknown> | undefined)?.exa;
  return scoped && typeof scoped === "object" && !Array.isArray(scoped)
    ? (scoped as ExaConfig)
    : {};
}

function resolveExaApiKey(
  config?: OpenClawConfig,
  searchConfig?: SearchConfigRecord,
): string | undefined {
  const exaConfig = resolveExaConfig(config, searchConfig);
  return (
    readConfiguredSecretString(exaConfig.apiKey, "plugins.entries.exa.config.webSearch.apiKey") ??
    readProviderEnvValue(["EXA_API_KEY"])
  );
}

function normalizeExaSearchType(value: string | undefined): ExaSearchType {
  if (value === "neural" || value === "keyword" || value === "auto") {
    return value;
  }
  return "auto";
}

function resolveDescription(result: ExaSearchResult): string {
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
  const text = result.text;
  return typeof text === "string" ? text : "";
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

async function runExaSearch(params: {
  apiKey: string;
  query: string;
  count: number;
  freshness?: string;
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
  };

  if (params.contents) {
    body.contents = params.contents;
  }
  if (params.dateAfter) {
    body.startPublishedDate = params.dateAfter;
  }
  if (params.dateBefore) {
    body.endPublishedDate = params.dateBefore;
  }
  if (!params.dateAfter && params.freshness) {
    // Compute start date from freshness keyword
    const now = new Date();
    if (params.freshness === "day") {
      now.setUTCDate(now.getUTCDate() - 1);
    } else if (params.freshness === "week") {
      now.setUTCDate(now.getUTCDate() - 7);
    } else if (params.freshness === "month") {
      // Fix month-boundary overflow: clamp day before setting month
      const targetMonth = now.getUTCMonth() - 1;
      const targetYear = targetMonth < 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
      const normalizedMonth = ((targetMonth % 12) + 12) % 12;
      const daysInTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
      now.setUTCDate(Math.min(now.getUTCDate(), daysInTargetMonth));
      now.setUTCFullYear(targetYear);
      now.setUTCMonth(normalizedMonth);
    } else if (params.freshness === "year") {
      now.setUTCFullYear(now.getUTCFullYear() - 1);
    }
    body.startPublishedDate = now.toISOString();
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
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
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
    type: Type.Optional(
      Type.Union([Type.Literal("neural"), Type.Literal("keyword"), Type.Literal("auto")], {
        description: "Exa search mode (neural, keyword, or auto). Default: auto.",
      }),
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
  });
}

function missingExaKeyPayload() {
  return {
    error: "missing_exa_api_key",
    message: `web_search (exa) needs an Exa API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set EXA_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createExaToolDefinition(
  config?: OpenClawConfig,
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Exa AI. Supports neural/keyword/auto search modes, publication date filters, and optional content highlights or full text extraction.",
    parameters: createExaSchema(),
    execute: async (args) => {
      const apiKey = resolveExaApiKey(config, searchConfig);
      if (!apiKey) {
        return missingExaKeyPayload();
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });

      // Validate type
      const rawType = readStringParam(params, "type");
      if (
        rawType !== undefined &&
        rawType !== "neural" &&
        rawType !== "keyword" &&
        rawType !== "auto"
      ) {
        return {
          error: "invalid_type",
          message: `type must be "neural", "keyword", or "auto", got "${rawType}".`,
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      // Validate contents
      const rawContents = params.contents;
      if (rawContents !== undefined) {
        if (!rawContents || typeof rawContents !== "object" || Array.isArray(rawContents)) {
          return {
            error: "invalid_contents",
            message: "contents must be an object with optional boolean highlights and text fields.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }
        const contentsObj = rawContents as Record<string, unknown>;
        for (const key of ["highlights", "text"] as const) {
          if (key in contentsObj && typeof contentsObj[key] !== "boolean") {
            return {
              error: "invalid_contents",
              message: `contents.${key} must be a boolean, got ${typeof contentsObj[key]}.`,
              docs: "https://docs.openclaw.ai/tools/web",
            };
          }
        }
        for (const key of Object.keys(contentsObj)) {
          if (key !== "highlights" && key !== "text") {
            return {
              error: "invalid_contents",
              message: `contents has unknown field "${key}". Only "highlights" and "text" are allowed.`,
              docs: "https://docs.openclaw.ai/tools/web",
            };
          }
        }
      }

      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;

      const rawFreshness = readStringParam(params, "freshness");
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "exa") : undefined;
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
            "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range, not both.",
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
          message: "date_after must be before date_before.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const type = normalizeExaSearchType(rawType);
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
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      const results = await runExaSearch({
        apiKey,
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        freshness,
        dateAfter,
        dateBefore,
        type,
        contents,
        timeoutSeconds,
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
          const description = resolveDescription(entry);
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
      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
  };
}

export function createExaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "exa",
    label: "Exa Search",
    hint: "Neural + keyword hybrid · date filters · content highlights",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    signupUrl: "https://exa.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 25,
    credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.exa.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const scoped = (searchConfig as Record<string, unknown> | undefined)?.exa;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        return undefined;
      }
      return (scoped as Record<string, unknown>).apiKey;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const target = searchConfigTarget as Record<string, unknown>;
      const scoped = target.exa;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        target.exa = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "exa")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "exa", "apiKey", value);
    },
    createTool: (ctx) =>
      createExaToolDefinition(ctx.config, ctx.searchConfig as SearchConfigRecord | undefined),
  };
}

export const __testing = {
  normalizeExaResults,
  resolveDescription,
  normalizeFreshness,
  normalizeToIsoDate,
} as const;
