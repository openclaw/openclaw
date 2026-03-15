import {
  buildSearchRequestCacheIdentity,
  createLegacySearchProviderMetadata,
  createMissingSearchKeyPayload,
  normalizeCacheKey,
  normalizeSecretInput,
  readCache,
  rejectUnsupportedSearchFilters,
  resolveSearchConfig,
  resolveSearchProviderSectionConfig,
  throwWebSearchApiError,
  type OpenClawConfig,
  type SearchProviderExecutionResult,
  type SearchProviderLegacyUiMetadata,
  type SearchProviderPlugin,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/web-search";

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";

const GROK_SEARCH_CACHE = new Map<string, { value: Record<string, unknown>; expiresAt: number }>();

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type GrokConfig = {
  apiKey?: string;
  model?: string;
  inlineCitations?: boolean;
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        start_index?: number;
        end_index?: number;
      }>;
    }>;
    annotations?: Array<{
      type?: string;
      url?: string;
      start_index?: number;
      end_index?: number;
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

function resolveGrokConfig(search?: WebSearchConfig): GrokConfig {
  return resolveSearchProviderSectionConfig<GrokConfig>(
    search as Record<string, unknown> | undefined,
    "grok",
  );
}

function resolveGrokApiKey(grok?: GrokConfig): string | undefined {
  return (
    normalizeSecretInput(grok?.apiKey) || normalizeSecretInput(process.env.XAI_API_KEY) || undefined
  );
}

function resolveGrokModel(grok?: GrokConfig): string {
  const fromConfig =
    grok && "model" in grok && typeof grok.model === "string" ? grok.model.trim() : "";
  return fromConfig || DEFAULT_GROK_MODEL;
}

function resolveGrokInlineCitations(grok?: GrokConfig): boolean {
  return grok?.inlineCitations === true;
}

function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    if (
      output.type === "output_text" &&
      "text" in output &&
      typeof output.text === "string" &&
      output.text
    ) {
      const rawAnnotations =
        "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
      const urls = rawAnnotations
        .filter(
          (a: Record<string, unknown>) => a.type === "url_citation" && typeof a.url === "string",
        )
        .map((a: Record<string, unknown>) => a.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}) {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [{ role: "user", content: params.query }],
    tools: [{ type: "web_search" }],
  };
  return withTrustedWebToolsEndpoint(
    {
      url: XAI_API_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwWebSearchApiError(response, "xAI");
      }
      const data = (await response.json()) as GrokSearchResponse;
      const { text: extractedText, annotationCitations } = extractGrokContent(data);
      return {
        content: extractedText ?? "No response",
        citations: (data.citations ?? []).length > 0 ? data.citations! : annotationCitations,
        inlineCitations: data.inline_citations,
      };
    },
  );
}

export const GROK_SEARCH_PROVIDER_METADATA: SearchProviderLegacyUiMetadata =
  createLegacySearchProviderMetadata({
    provider: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envKeys: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    apiKeyConfigPath: "tools.web.search.grok.apiKey",
  });

export function createBundledGrokSearchProvider(): SearchProviderPlugin {
  return {
    id: "grok",
    name: "xAI Grok",
    description:
      "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
    pluginOwnedExecution: true,
    legacyConfig: GROK_SEARCH_PROVIDER_METADATA,
    isAvailable: (config) =>
      Boolean(
        resolveGrokApiKey(
          resolveGrokConfig(
            resolveSearchConfig<WebSearchConfig>(
              config?.tools?.web?.search as Record<string, unknown>,
            ),
          ),
        ),
      ),
    search: async (request, ctx): Promise<SearchProviderExecutionResult> => {
      const search = resolveSearchConfig<WebSearchConfig>(request.providerConfig);
      const grokConfig = resolveGrokConfig(search);
      const apiKey = resolveGrokApiKey(grokConfig);
      if (!apiKey) {
        return createMissingSearchKeyPayload(
          "missing_xai_api_key",
          "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure tools.web.search.grok.apiKey.",
        );
      }
      const unsupportedFilter = rejectUnsupportedSearchFilters({
        providerName: "grok",
        request,
        support: {
          country: false,
          language: false,
          freshness: false,
          date: false,
          domainFilter: false,
        },
      });
      if (unsupportedFilter) {
        return unsupportedFilter;
      }

      const model = resolveGrokModel(grokConfig);
      const inlineCitationsEnabled = resolveGrokInlineCitations(grokConfig);
      const cacheKey = normalizeCacheKey(
        `grok:${model}:${String(inlineCitationsEnabled)}:${buildSearchRequestCacheIdentity({
          query: request.query,
          count: request.count,
        })}`,
      );
      const cached = readCache(GROK_SEARCH_CACHE, cacheKey);
      if (cached) return { ...cached.value, cached: true } as SearchProviderExecutionResult;
      const startedAt = Date.now();
      const result = await runGrokSearch({
        query: request.query,
        apiKey,
        model,
        timeoutSeconds: ctx.timeoutSeconds,
        inlineCitations: inlineCitationsEnabled,
      });
      const payload = {
        query: request.query,
        provider: "grok",
        model,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "grok",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
        inlineCitations: result.inlineCitations,
      };
      writeCache(GROK_SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
      return payload as SearchProviderExecutionResult;
    },
  };
}

export const __testing = {
  GROK_SEARCH_CACHE,
  clearSearchProviderCaches() {
    GROK_SEARCH_CACHE.clear();
  },
} as const;
