import { Type } from "@sinclair/typebox";
import { normalizeXaiModelId } from "openclaw/plugin-sdk/provider-models";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  getScopedCredentialValue,
  MAX_SEARCH_COUNT,
  postTrustedWebToolsJson,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  setScopedCredentialValue,
  setProviderWebSearchPluginConfigValue,
  wrapWebContent,
  writeCachedSearchPayload,
  type SearchConfigRecord,
  type WebSearchProviderPlugin,
  type WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";

const XAI_DEFAULT_BASE_URL = "https://api.x.ai/v1";
const XAI_DEFAULT_WEB_SEARCH_MODEL = "grok-4-1-fast";

type XaiWebSearchResponse = {
  output?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
    }>;
  }>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};

type XaiWebSearchConfig = Record<string, unknown> & {
  model?: unknown;
  inlineCitations?: unknown;
  baseUrl?: unknown;
};

type XaiWebSearchResult = {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveXaiSearchConfig(searchConfig?: Record<string, unknown>): XaiWebSearchConfig {
  return (asRecord(searchConfig?.grok) as XaiWebSearchConfig | undefined) ?? {};
}

function resolveXaiWebSearchModel(searchConfig?: Record<string, unknown>): string {
  const config = resolveXaiSearchConfig(searchConfig);
  return typeof config.model === "string" && config.model.trim()
    ? normalizeXaiModelId(config.model.trim())
    : XAI_DEFAULT_WEB_SEARCH_MODEL;
}

function resolveXaiInlineCitations(searchConfig?: Record<string, unknown>): boolean {
  return resolveXaiSearchConfig(searchConfig).inlineCitations === true;
}

function resolveXaiBaseUrl(searchConfig?: Record<string, unknown>): string {
  const config = resolveXaiSearchConfig(searchConfig);
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  return baseUrl ? baseUrl.replace(/\/$/, "") : XAI_DEFAULT_BASE_URL;
}

function extractXaiWebSearchContent(data: XaiWebSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter(
              (annotation) =>
                annotation.type === "url_citation" && typeof annotation.url === "string",
            )
            .map((annotation) => annotation.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }

    if (output.type === "output_text" && typeof output.text === "string" && output.text) {
      const urls = (output.annotations ?? [])
        .filter(
          (annotation) => annotation.type === "url_citation" && typeof annotation.url === "string",
        )
        .map((annotation) => annotation.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }

  return {
    text: typeof data.output_text === "string" ? data.output_text : undefined,
    annotationCitations: [],
  };
}

function buildXaiWebSearchPayload(params: {
  query: string;
  provider: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: params.provider,
    model: params.model,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    content: wrapWebContent(params.content, "web_search"),
    citations: params.citations,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
  };
}

async function requestXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  baseUrl: string;
}): Promise<XaiWebSearchResult> {
  return await postTrustedWebToolsJson(
    {
      url: `${params.baseUrl}/responses`,
      timeoutSeconds: params.timeoutSeconds,
      apiKey: params.apiKey,
      body: {
        model: params.model,
        input: [{ role: "user", content: params.query }],
        tools: [{ type: "web_search" }],
      },
      errorLabel: "xAI",
    },
    async (response) => {
      const data = (await response.json()) as XaiWebSearchResponse;
      const { text, annotationCitations } = extractXaiWebSearchContent(data);
      const citations =
        Array.isArray(data.citations) && data.citations.length > 0
          ? data.citations
          : annotationCitations;
      return {
        content: text ?? "No response",
        citations,
        inlineCitations:
          params.inlineCitations && Array.isArray(data.inline_citations)
            ? data.inline_citations
            : undefined,
      };
    },
  );
}

function resolveGrokApiKey(grok?: Record<string, unknown>): string | undefined {
  return (
    readConfiguredSecretString(grok?.apiKey, "tools.web.search.grok.apiKey") ??
    readProviderEnvValue(["XAI_API_KEY"])
  );
}

function createGrokSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    language: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Grok." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Grok." })),
  });
}

function createGrokToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
    parameters: createGrokSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      const unsupportedResponse = buildUnsupportedSearchFilterResponse(params, "grok");
      if (unsupportedResponse) {
        return unsupportedResponse;
      }

      const grokConfig = resolveXaiSearchConfig(searchConfig);
      const apiKey = resolveGrokApiKey(grokConfig);
      if (!apiKey) {
        return {
          error: "missing_xai_api_key",
          message:
            "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveXaiWebSearchModel(searchConfig);
      const inlineCitations = resolveXaiInlineCitations(searchConfig);
      const baseUrl = resolveXaiBaseUrl(searchConfig);
      const cacheKey = buildSearchCacheKey([
        "grok",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        baseUrl,
        model,
        inlineCitations,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await requestXaiWebSearch({
        query,
        apiKey,
        model,
        timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
        inlineCitations,
        baseUrl,
      });
      const payload = buildXaiWebSearchPayload({
        query,
        provider: "grok",
        model,
        tookMs: Date.now() - start,
        content: result.content,
        citations: result.citations,
        inlineCitations: result.inlineCitations,
      });
      writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
      return payload;
    },
  };
}

export function createGrokWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "Requires xAI API key · xAI web-grounded responses",
    credentialLabel: "xAI API key",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "grok"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "grok", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "xai")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "xai", "apiKey", value);
    },
    createTool: (ctx) =>
      createGrokToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig as SearchConfigRecord | undefined,
          "grok",
          resolveProviderWebSearchPluginConfig(ctx.config, "xai"),
        ) as SearchConfigRecord | undefined,
      ),
  };
}

export const __testing = {
  resolveGrokApiKey,
  resolveGrokModel: (grok?: Record<string, unknown>) =>
    resolveXaiWebSearchModel(grok ? { grok } : undefined),
  resolveGrokInlineCitations: (grok?: Record<string, unknown>) =>
    resolveXaiInlineCitations(grok ? { grok } : undefined),
  resolveXaiBaseUrl,
  extractGrokContent: extractXaiWebSearchContent,
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiSearchConfig,
  resolveXaiWebSearchModel,
  requestXaiWebSearch,
  buildXaiWebSearchPayload,
  XAI_DEFAULT_WEB_SEARCH_MODEL,
} as const;
