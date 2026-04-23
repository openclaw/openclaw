import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  formatCliCommand,
  mergeScopedSearchConfig,
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
  getScopedCredentialValue,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  throwWebSearchApiError,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";

const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";

type SerperSearchResult = {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
};

type SerperSearchResponse = {
  organic?: SerperSearchResult[];
};

type SerperConfig = {
  apiKey?: string;
};

function resolveSerperConfig(searchConfig?: SearchConfigRecord): SerperConfig {
  const serper = searchConfig?.serper;
  return serper && typeof serper === "object" && !Array.isArray(serper)
    ? (serper as SerperConfig)
    : {};
}

function resolveSerperApiKey(serper?: SerperConfig): string | undefined {
  return (
    readConfiguredSecretString(serper?.apiKey, "tools.web.search.serper.apiKey") ??
    readProviderEnvValue(["SERPER_API_KEY"])
  );
}

function missingSerperKeyPayload() {
  return {
    error: "missing_serper_api_key",
    message: `web_search (serper) needs a Serper API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set SERPER_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createSerperSchema() {
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
      country: Type.Optional(
        Type.String({
          description:
            "2-letter country code for region-specific results (e.g., 'de', 'us'). Maps to Google's gl parameter.",
        }),
      ),
      language: Type.Optional(
        Type.String({
          description:
            "ISO language code for search results (e.g., 'en', 'de', 'fr'). Maps to Google's hl parameter.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

async function runSerperSearch(params: {
  query: string;
  apiKey: string;
  count: number;
  country?: string;
  language?: string;
  timeoutSeconds: number;
}): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    q: params.query,
    num: params.count,
  };

  if (params.country) {
    body.gl = params.country.toLowerCase();
  }

  if (params.language) {
    body.hl = params.language.toLowerCase();
  }

  return withTrustedWebSearchEndpoint(
    {
      url: SERPER_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": params.apiKey,
        },
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Serper");
      }

      const data = (await res.json()) as SerperSearchResponse;
      const organic = Array.isArray(data.organic) ? data.organic : [];
      return organic.map((entry) => {
        const title = entry.title ?? "";
        const url = entry.link ?? "";
        const description = entry.snippet ?? "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url,
          description: description ? wrapWebContent(description, "web_search") : "",
          published: entry.date || undefined,
          siteName: resolveSiteName(url) || undefined,
        };
      });
    },
  );
}

function createSerperToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const serperConfig = resolveSerperConfig(searchConfig);

  return {
    description:
      "Search the web using Serper API (Google Search wrapper). Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.",
    parameters: createSerperSchema(),
    execute: async (args) => {
      const apiKey = resolveSerperApiKey(serperConfig);
      if (!apiKey) {
        return missingSerperKeyPayload();
      }

      const params = args;

      // Serper supports country and language but not time-based filters.
      // Strip supported fields so the shared helper only checks unsupported ones.
      const { country: _c, language: _l, ...filterCheckParams } = params;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(filterCheckParams, "serper");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const country = readStringParam(params, "country");
      const language = readStringParam(params, "language");

      const cacheKey = buildSearchCacheKey([
        "serper",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        country,
        language,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      const results = await runSerperSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds,
        country: country ?? undefined,
        language: language ?? undefined,
      });

      const payload = {
        query,
        provider: "serper",
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "serper",
          wrapped: true,
        },
        results,
      };

      writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
      return payload;
    },
  };
}

export function createSerperWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "serper",
    label: "Serper (Google Search)",
    hint: "Structured Google Search results · free tier available",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Serper API key",
    envVars: ["SERPER_API_KEY"],
    placeholder: "...",
    signupUrl: "https://serper.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/serper-search",
    autoDetectOrder: 25,
    credentialPath: "plugins.entries.serper.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.serper.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "serper"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "serper", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "serper")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "serper", "apiKey", value);
    },
    createTool: (ctx) =>
      createSerperToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "serper",
          resolveProviderWebSearchPluginConfig(ctx.config, "serper"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveSerperApiKey,
  runSerperSearch,
} as const;
