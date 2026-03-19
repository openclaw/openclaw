import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
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
  setTopLevelCredentialValue,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

type ExaSearchResult = {
  title?: string;
  url?: string;
  publishedDate?: string;
  highlights?: string[];
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

function resolveExaApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["EXA_API_KEY"])
  );
}

async function runExaSearch(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.count,
    contents: { highlights: true },
  };
  if (params.dateAfter) body.startPublishedDate = params.dateAfter;
  if (params.dateBefore) body.endPublishedDate = params.dateBefore;

  return withTrustedWebSearchEndpoint(
    {
      url: EXA_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
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
        throw new Error(`Exa Search API error (${res.status}): ${detail || res.statusText}`);
      }
      const data = (await res.json()) as ExaSearchResponse;
      return (data.results ?? []).map((entry) => {
        const title = entry.title ?? "";
        const url = entry.url ?? "";
        const highlights = (entry.highlights ?? []).filter(
          (h): h is string => typeof h === "string" && h.length > 0,
        );
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description:
            highlights.length > 0 ? wrapWebContent(highlights.join(" … "), "web_search") : "",
          published: entry.publishedDate ?? undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
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
    date_after: Type.Optional(
      Type.String({ description: "Only results published after this date (YYYY-MM-DD)." }),
    ),
    date_before: Type.Optional(
      Type.String({ description: "Only results published before this date (YYYY-MM-DD)." }),
    ),
  });
}

function createExaToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Exa, a neural search engine. Returns titles, URLs, and highlighted snippets. Supports date range filtering.",
    parameters: createExaSchema(),
    execute: async (args) => {
      const apiKey = resolveExaApiKey(searchConfig);
      if (!apiKey) {
        return {
          error: "missing_exa_api_key",
          message: `web_search (exa) needs an Exa API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set EXA_API_KEY in the Gateway environment.`,
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;

      const rawDateAfter = readStringParam(params, "date_after");
      const rawDateBefore = readStringParam(params, "date_before");
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

      const cacheKey = buildSearchCacheKey([
        "exa",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
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

      const results = await runExaSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds,
        dateAfter,
        dateBefore,
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
        results,
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
    hint: "Neural search · highlighted snippets · date filtering",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    signupUrl: "https://exa.ai/",
    docsUrl: "https://docs.exa.ai/",
    autoDetectOrder: 5,
    credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.exa.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: setTopLevelCredentialValue,
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "exa")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "exa", "apiKey", value);
    },
    createTool: (ctx) => {
      const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
      const pluginConfig = resolveProviderWebSearchPluginConfig(ctx.config, "exa");
      if (!pluginConfig) {
        return createExaToolDefinition(searchConfig);
      }
      return createExaToolDefinition({
        ...(searchConfig ?? {}),
        ...(pluginConfig.apiKey === undefined ? {} : { apiKey: pluginConfig.apiKey }),
      } as SearchConfigRecord);
    },
  };
}
