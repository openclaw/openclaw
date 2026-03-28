import { Type } from "@sinclair/typebox";
import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  enablePluginInConfig,
  getScopedCredentialValue,
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
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";

const BAIDU_SEARCH_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/chat/completions";
const BAIDU_DIRECT_MODE = "direct";
const BAIDU_SMART_MODE = "smart";
const DEFAULT_BAIDU_SMART_MODEL = "ernie-4.5-turbo-32k";
const BAIDU_SEARCH_SOURCE = "baidu_search_v2";
const BAIDU_API_ENV_VARS = ["QIANFAN_API_KEY"] as const;

type BaiduMode = typeof BAIDU_DIRECT_MODE | typeof BAIDU_SMART_MODE;

type BaiduConfig = {
  apiKey?: string;
  mode?: string;
  model?: string;
};

type BaiduReference = {
  url?: string;
  title?: string;
  date?: string;
  content?: string;
  snippet?: string;
  website?: string;
  type?: string;
};

type BaiduSmartResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      role?: string;
    };
  }>;
  references?: BaiduReference[];
  error?: {
    code?: number;
    message?: string;
  };
};

type BaiduDirectResponse = {
  references?: BaiduReference[];
  error?: {
    code?: number;
    message?: string;
  };
};

type BaiduSearchResult = {
  title: string;
  url: string;
  description: string;
  published?: string;
  siteName?: string;
};

function resolveBaiduConfig(searchConfig?: SearchConfigRecord): BaiduConfig {
  const baidu = searchConfig?.baidu;
  return baidu && typeof baidu === "object" && !Array.isArray(baidu) ? (baidu as BaiduConfig) : {};
}

function resolveBaiduApiKey(baidu?: BaiduConfig): string | undefined {
  return (
    readConfiguredSecretString(baidu?.apiKey, "tools.web.search.baidu.apiKey") ??
    readProviderEnvValue([...BAIDU_API_ENV_VARS])
  );
}

function resolveBaiduMode(baidu?: BaiduConfig): BaiduMode {
  return baidu?.mode === BAIDU_SMART_MODE ? BAIDU_SMART_MODE : BAIDU_DIRECT_MODE;
}

function resolveBaiduSmartModel(baidu?: BaiduConfig): string {
  const model = typeof baidu?.model === "string" ? baidu.model.trim() : "";
  return model || DEFAULT_BAIDU_SMART_MODEL;
}

function normalizeBaiduReferences(data: { references?: BaiduReference[] }): BaiduReference[] {
  return Array.isArray(data.references)
    ? data.references.filter((entry): entry is BaiduReference =>
        Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
}

function mapBaiduReferencesToResults(references: BaiduReference[]): BaiduSearchResult[] {
  return references.flatMap((entry) => {
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url) {
      return [];
    }
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    const description =
      typeof entry.snippet === "string" && entry.snippet.trim()
        ? entry.snippet.trim()
        : typeof entry.content === "string"
          ? entry.content.trim()
          : "";
    const published = typeof entry.date === "string" ? entry.date.trim() : "";
    const siteName =
      typeof entry.website === "string" && entry.website.trim()
        ? entry.website.trim()
        : resolveSiteName(url) || undefined;
    return [
      {
        title: title ? wrapWebContent(title, "web_search") : "",
        url,
        description: description ? wrapWebContent(description, "web_search") : "",
        published: published || undefined,
        siteName,
      },
    ];
  });
}

function mapBaiduReferencesToCitations(
  references: BaiduReference[],
): Array<{ url: string; title?: string }> {
  const seen = new Set<string>();
  const citations: Array<{ url: string; title?: string }> = [];
  for (const entry of references) {
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    citations.push({
      url,
      ...(title ? { title } : {}),
    });
  }
  return citations;
}

async function parseBaiduResponseJson<T extends { error?: { code?: number; message?: string } }>(
  res: Response,
  label: string,
): Promise<T> {
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`${label} error (${res.status}): ${bodyText || res.statusText}`);
  }

  let data: T;
  try {
    data = JSON.parse(bodyText) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${String(error)}`, { cause: error });
  }

  if (data.error) {
    const code = data.error.code ?? res.status;
    const message = data.error.message?.trim() || "unknown error";
    throw new Error(`${label} error (${code}): ${message}`);
  }

  return data;
}

async function runBaiduDirectSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
}): Promise<Array<Record<string, unknown>>> {
  return await withTrustedWebSearchEndpoint(
    {
      url: BAIDU_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appbuilder-Authorization": `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: params.query }],
          search_source: BAIDU_SEARCH_SOURCE,
          resource_type_filter: [{ type: "web", top_k: params.count }],
          stream: false,
          search_mode: "required",
        }),
      },
    },
    async (res) => {
      const data = await parseBaiduResponseJson<BaiduDirectResponse>(res, "Baidu Search API");
      return mapBaiduReferencesToResults(normalizeBaiduReferences(data));
    },
  );
}

async function runBaiduSmartSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  return await withTrustedWebSearchEndpoint(
    {
      url: BAIDU_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appbuilder-Authorization": `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: params.query }],
          search_source: BAIDU_SEARCH_SOURCE,
          resource_type_filter: [{ type: "web", top_k: params.count }],
          stream: false,
          model: params.model,
          search_mode: "required",
          enable_reasoning: false,
          enable_deep_search: false,
        }),
      },
    },
    async (res) => {
      const data = await parseBaiduResponseJson<BaiduSmartResponse>(res, "Baidu Smart Search API");
      const references = normalizeBaiduReferences(data);
      return {
        content: data.choices?.[0]?.message?.content?.trim() || "No response",
        citations: mapBaiduReferencesToCitations(references),
      };
    },
  );
}

function createBaiduSchema() {
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
      country: Type.Optional(Type.String({ description: "Not supported by Baidu web search." })),
      language: Type.Optional(Type.String({ description: "Not supported by Baidu web search." })),
      freshness: Type.Optional(Type.String({ description: "Not supported by Baidu web search." })),
      date_after: Type.Optional(Type.String({ description: "Not supported by Baidu web search." })),
      date_before: Type.Optional(
        Type.String({ description: "Not supported by Baidu web search." }),
      ),
    },
    { additionalProperties: false },
  );
}

function missingBaiduKeyPayload() {
  return {
    error: "missing_baidu_api_key",
    message:
      "web_search (baidu) needs a Qianfan API key. Set QIANFAN_API_KEY in the Gateway environment, or configure plugins.entries.qianfan.config.webSearch.apiKey.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function createBaiduToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  const baiduConfig = resolveBaiduConfig(searchConfig);
  const mode = resolveBaiduMode(baiduConfig);

  return {
    description:
      mode === BAIDU_SMART_MODE
        ? "Search the web using Baidu smart search via Qianfan. Returns AI-synthesized answers with citations from Baidu Search."
        : "Search the web using Baidu direct search via Qianfan. Returns structured titles, URLs, and snippets with strong Chinese-language coverage.",
    parameters: createBaiduSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(params, "baidu");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const apiKey = resolveBaiduApiKey(baiduConfig);
      if (!apiKey) {
        return missingBaiduKeyPayload();
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
      const smartModel = mode === BAIDU_SMART_MODE ? resolveBaiduSmartModel(baiduConfig) : "";
      const cacheKey = buildSearchCacheKey(
        mode === BAIDU_SMART_MODE
          ? ["baidu", mode, query, resolvedCount, smartModel]
          : ["baidu", mode, query, resolvedCount],
      );
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      if (mode === BAIDU_SMART_MODE) {
        const result = await runBaiduSmartSearch({
          query,
          count: resolvedCount,
          apiKey,
          model: smartModel,
          timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        });
        const payload = {
          query,
          provider: "baidu",
          mode,
          model: smartModel,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "baidu",
            wrapped: true,
          },
          content: wrapWebContent(result.content),
          citations: result.citations,
        };
        writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
        return payload;
      }

      const results = await runBaiduDirectSearch({
        query,
        count: resolvedCount,
        apiKey,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
      });
      const payload = {
        query,
        provider: "baidu",
        mode,
        count: results.length,
        tookMs: Date.now() - start,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "baidu",
          wrapped: true,
        },
        results,
      };
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createBaiduWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "baidu",
    label: "Baidu Search",
    hint: "Chinese-first web search via Qianfan · direct or AI-synthesized modes",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Baidu / Qianfan API key",
    envVars: [...BAIDU_API_ENV_VARS],
    placeholder: "bce-v3/...",
    signupUrl: "https://console.bce.baidu.com/qianfan/ais/console/apiKey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 55,
    credentialPath: "plugins.entries.qianfan.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.qianfan.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "baidu"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "baidu", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "qianfan")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "qianfan", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "qianfan").config,
    createTool: (ctx) =>
      createBaiduToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "baidu",
          resolveProviderWebSearchPluginConfig(ctx.config, "qianfan"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveBaiduApiKey,
  resolveBaiduConfig,
  resolveBaiduMode,
  resolveBaiduSmartModel,
  mapBaiduReferencesToResults,
  mapBaiduReferencesToCitations,
} as const;
