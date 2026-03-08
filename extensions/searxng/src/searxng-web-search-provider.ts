import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  mergeScopedSearchConfig,
  readCachedSearchPayload,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  throwWebSearchApiError,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_SEARXNG_BASE_URL = "http://localhost:8888";

type SearxngSearchResult = {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
  engine?: string;
};

type SearxngSearchResponse = {
  query?: string;
  results?: SearxngSearchResult[];
};

function resolveSearxngBaseUrl(searchConfig?: SearchConfigRecord): string {
  const searxng = searchConfig?.searxng;
  const fromConfig =
    searxng && typeof searxng === "object" && !Array.isArray(searxng)
      ? ((searxng as { baseUrl?: string }).baseUrl ?? "").trim()
      : "";
  const fromEnv = (process.env.SEARXNG_BASE_URL ?? "").trim();
  return fromConfig || fromEnv || DEFAULT_SEARXNG_BASE_URL;
}

async function runSearxngSearch(params: {
  query: string;
  baseUrl: string;
  timeoutSeconds: number;
  language?: string;
}): Promise<SearxngSearchResult[]> {
  const base = params.baseUrl.trim().replace(/\/$/, "");
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  if (params.language) {
    url.searchParams.set("language", params.language);
  }

  return withTrustedWebSearchEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    },
    async (res) => {
      if (!res.ok) {
        await throwWebSearchApiError(res, "SearXNG");
      }
      const data = (await res.json()) as SearxngSearchResponse;
      return data.results ?? [];
    },
  );
}

const SearxngWebSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: `Number of results (1-${MAX_SEARCH_COUNT}).`,
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    search_lang: Type.Optional(
      Type.String({
        description: "Language code for search results (e.g. en, de, fr).",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Time filter (not supported by SearXNG; will return an error if set).",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSearxngWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "searxng",
    label: "SearXNG",
    hint: "Self-hosted metasearch · no API key required",
    envVars: ["SEARXNG_BASE_URL"],
    placeholder: "http://localhost:8888",
    signupUrl: "https://docs.searxng.org/",
    docsUrl: "https://docs.openclaw.ai/tools/searxng",
    autoDetectOrder: 999,
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    inactiveSecretPaths: [],
    getCredentialValue: () => undefined,
    setCredentialValue: () => undefined,
    getConfiguredCredentialValue: () => undefined,
    setConfiguredCredentialValue: () => undefined,
    createTool: (ctx) => {
      const searchConfig = mergeScopedSearchConfig(
        ctx.searchConfig as SearchConfigRecord | undefined,
        "searxng",
        resolveProviderWebSearchPluginConfig(ctx.config, "searxng"),
      ) as SearchConfigRecord | undefined;
      const baseUrl = resolveSearxngBaseUrl(searchConfig);
      const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
      const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

      return {
        description:
          "Search the web using SearXNG (self-hosted meta search engine). Aggregates results from multiple search engines. Returns titles, URLs, and snippets for fast research.",
        parameters: SearxngWebSearchSchema,
        execute: async (args) => {
          const params = args as Record<string, unknown>;
          const query = typeof params.query === "string" ? params.query.trim() : "";
          if (!query) {
            return { error: "missing_query", message: "query is required." };
          }

          const count = resolveSearchCount(
            typeof params.count === "number" ? params.count : undefined,
            DEFAULT_SEARCH_COUNT,
          );
          const language = typeof params.search_lang === "string" ? params.search_lang : undefined;

          // SearXNG does not support freshness filtering.
          const unsupported = buildUnsupportedSearchFilterResponse(params, "searxng");
          if (unsupported) {
            return unsupported;
          }

          const cacheKey = buildSearchCacheKey(["searxng", query, count, language ?? "default"]);
          const cached = readCachedSearchPayload(cacheKey);
          if (cached) {
            return cached;
          }

          const start = Date.now();
          const results = await runSearxngSearch({
            query,
            baseUrl,
            timeoutSeconds,
            language,
          });

          const mapped = results.slice(0, count).map((entry) => {
            const title = entry.title ?? "";
            const url = entry.url ?? "";
            const description = entry.content ?? "";
            const rawSiteName = resolveSiteName(url);
            return {
              title: title ? wrapWebContent(title, "web_search") : "",
              url,
              description: description ? wrapWebContent(description, "web_search") : "",
              published: entry.publishedDate || undefined,
              siteName: rawSiteName || undefined,
              engine: entry.engine || undefined,
            };
          });

          const payload = {
            query,
            provider: "searxng",
            tookMs: Date.now() - start,
            count: mapped.length,
            externalContent: {
              untrusted: true,
              source: "web_search",
              provider: "searxng",
              wrapped: true,
            },
            results: mapped,
          };
          writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
          return payload;
        },
      };
    },
  };
}

export const __testing = {
  resolveSearxngBaseUrl,
} as const;
