import { Type } from "@sinclair/typebox";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readResponseText,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setProviderWebSearchPluginConfigValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const DEFAULT_PARALLEL_BASE_URL = "https://api.parallel.ai";

type ParallelConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type ParallelSearchResult = {
  title?: string;
  url?: string;
  text?: string;
  excerpts?: string[];
};

type ParallelSearchResponse = {
  results?: ParallelSearchResult[];
};

function resolveParallelConfig(searchConfig?: SearchConfigRecord): ParallelConfig {
  // searchConfig.parallel is already merged (plugin + legacy) by createTool,
  // so we just read the scoped sub-object directly.
  const parallel = (searchConfig as Record<string, unknown> | undefined)?.parallel;
  return parallel && typeof parallel === "object" && !Array.isArray(parallel)
    ? (parallel as ParallelConfig)
    : {};
}

function resolveParallelApiKey(parallel?: ParallelConfig): string | undefined {
  return (
    readConfiguredSecretString(
      parallel?.apiKey,
      "plugins.entries.parallel.config.webSearch.apiKey",
    ) ?? readProviderEnvValue(["PARALLEL_API_KEY"])
  );
}

function resolveParallelBaseUrl(parallel?: ParallelConfig): string {
  const raw = typeof parallel?.baseUrl === "string" ? parallel.baseUrl.trim() : "";
  return raw || DEFAULT_PARALLEL_BASE_URL;
}

async function runParallelSearch(params: {
  query: string;
  count?: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<Array<{ title: string; url: string; text: string }>> {
  return withTrustedWebSearchEndpoint(
    {
      url: `${params.baseUrl.replace(/\/+$/, "")}/v1beta/search`,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": params.apiKey,
        },
        body: JSON.stringify({
          objective: params.query,
          mode: "fast",
          ...(params.count ? { max_results: params.count } : {}),
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const detailResult = await readResponseText(res, { maxBytes: 64_000 });
        const detail = detailResult.text;
        throw new Error(`Parallel Search API error (${res.status}): ${detail || res.statusText}`);
      }
      const data = (await res.json()) as ParallelSearchResponse;
      const results = (data.results ?? []).map((r) => {
        const title = r.title ?? "";
        const text = r.text || (r.excerpts ?? []).join("\n\n") || "";
        return {
          title: title ? wrapWebContent(title, "web_search") : "",
          url: r.url ?? "",
          text: text ? wrapWebContent(text, "web_search") : "",
        };
      });
      const sliced = params.count ? results.slice(0, params.count) : results;
      return sliced;
    },
  );
}

function createParallelSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
  });
}

function createParallelToolDefinition(
  config?: unknown,
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Parallel. Returns relevant excerpts from web search optimized for LLMs.",
    parameters: createParallelSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const parallelConfig = resolveParallelConfig(searchConfig);
      const apiKey = resolveParallelApiKey(parallelConfig);
      if (!apiKey) {
        return {
          error: "missing_parallel_api_key",
          message:
            "web_search (parallel) needs a Parallel API key. Set PARALLEL_API_KEY in the Gateway environment, or configure tools.web.search.parallel.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count = readNumberParam(params, "count", { integer: true }) ?? searchConfig?.maxResults;
      const baseUrl = resolveParallelBaseUrl(parallelConfig);
      const cacheKey = buildSearchCacheKey([
        "parallel",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        baseUrl,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const results = await runParallelSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        baseUrl,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });
      const payload = {
        query,
        provider: "parallel",
        tookMs: Date.now() - start,
        results,
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createParallelWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "parallel",
    label: "Parallel",
    hint: "LLM-optimized excerpts",
    envVars: ["PARALLEL_API_KEY"],
    placeholder: "par-...",
    signupUrl: "https://parallel.ai",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 45,
    credentialPath: "plugins.entries.parallel.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.parallel.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => {
      const parallel = searchConfig?.parallel;
      return parallel && typeof parallel === "object" && !Array.isArray(parallel)
        ? (parallel as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.parallel;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.parallel = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "parallel")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "parallel", "apiKey", value);
    },
    createTool: (ctx) =>
      createParallelToolDefinition(
        ctx.config,
        (() => {
          const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
          const pluginConfig = resolveProviderWebSearchPluginConfig(
            ctx.config as Record<string, unknown> | undefined,
            "parallel",
          );
          if (!pluginConfig) {
            return searchConfig;
          }
          return {
            ...(searchConfig ?? {}),
            parallel: {
              ...resolveParallelConfig(searchConfig),
              ...pluginConfig,
            },
          } as SearchConfigRecord;
        })(),
      ),
  };
}

export const __testing = {
  resolveParallelApiKey,
  resolveParallelBaseUrl,
} as const;
