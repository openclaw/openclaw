import {
  buildSearchRequestCacheIdentity,
  createLegacySearchProviderMetadata,
  createMissingSearchKeyPayload,
  normalizeCacheKey,
  normalizeSecretInput,
  readCache,
  readResponseText,
  rejectUnsupportedSearchFilters,
  resolveCitationRedirectUrl,
  resolveSearchConfig,
  resolveSearchProviderSectionConfig,
  type OpenClawConfig,
  type SearchProviderExecutionResult,
  type SearchProviderLegacyUiMetadata,
  type SearchProviderPlugin,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/web-search";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const GEMINI_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number }
>();

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type GeminiConfig = {
  apiKey?: string;
  model?: string;
};

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

function resolveGeminiConfig(search?: WebSearchConfig): GeminiConfig {
  return resolveSearchProviderSectionConfig<GeminiConfig>(
    search as Record<string, unknown> | undefined,
    "gemini",
  );
}

function resolveGeminiApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    normalizeSecretInput(gemini?.apiKey) ||
    normalizeSecretInput(process.env.GEMINI_API_KEY) ||
    undefined
  );
}

function resolveGeminiModel(gemini?: GeminiConfig): string {
  const fromConfig =
    gemini && "model" in gemini && typeof gemini.model === "string" ? gemini.model.trim() : "";
  return fromConfig || DEFAULT_GEMINI_MODEL;
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;
  return withTrustedWebToolsEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.query }] }],
          tools: [{ google_search: {} }],
        }),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        const detailResult = await readResponseText(response, { maxBytes: 64_000 });
        const safeDetail = (detailResult.text || response.statusText).replace(
          /key=[^&\s]+/gi,
          "key=***",
        );
        throw new Error(`Gemini API error (${response.status}): ${safeDetail}`);
      }
      let data: GeminiGroundingResponse;
      try {
        data = (await response.json()) as GeminiGroundingResponse;
      } catch (err) {
        const safeError = String(err).replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: err });
      }
      if (data.error) {
        const rawMsg = data.error.message || data.error.status || "unknown";
        const safeMsg = rawMsg.replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API error (${data.error.code}): ${safeMsg}`);
      }
      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((p) => p.text)
          .filter(Boolean)
          .join("\n") ?? "No response";
      const groundingChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
      const rawCitations = groundingChunks
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));
      const citations: Array<{ url: string; title?: string }> = [];
      const MAX_CONCURRENT_REDIRECTS = 10;
      for (let i = 0; i < rawCitations.length; i += MAX_CONCURRENT_REDIRECTS) {
        const batch = rawCitations.slice(i, i + MAX_CONCURRENT_REDIRECTS);
        const resolved = await Promise.all(
          batch.map(async (citation) => ({
            ...citation,
            url: await resolveCitationRedirectUrl(citation.url),
          })),
        );
        citations.push(...resolved);
      }
      return { content, citations };
    },
  );
}

export const GEMINI_SEARCH_PROVIDER_METADATA: SearchProviderLegacyUiMetadata =
  createLegacySearchProviderMetadata({
    provider: "gemini",
    label: "Gemini (Google Search)",
    hint: "Google Search grounding · AI-synthesized",
    envKeys: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
    apiKeyConfigPath: "tools.web.search.gemini.apiKey",
  });

export function createBundledGeminiSearchProvider(): SearchProviderPlugin {
  return {
    id: "gemini",
    name: "Gemini Search",
    description:
      "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search.",
    pluginOwnedExecution: true,
    legacyConfig: GEMINI_SEARCH_PROVIDER_METADATA,
    isAvailable: (config) =>
      Boolean(
        resolveGeminiApiKey(
          resolveGeminiConfig(
            resolveSearchConfig<WebSearchConfig>(
              config?.tools?.web?.search as Record<string, unknown>,
            ),
          ),
        ),
      ),
    search: async (request, ctx): Promise<SearchProviderExecutionResult> => {
      const search = resolveSearchConfig<WebSearchConfig>(request.providerConfig);
      const geminiConfig = resolveGeminiConfig(search);
      const apiKey = resolveGeminiApiKey(geminiConfig);
      if (!apiKey) {
        return createMissingSearchKeyPayload(
          "missing_gemini_api_key",
          "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
        );
      }
      const unsupportedFilter = rejectUnsupportedSearchFilters({
        providerName: "gemini",
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

      const model = resolveGeminiModel(geminiConfig);
      const cacheKey = normalizeCacheKey(
        `gemini:${model}:${buildSearchRequestCacheIdentity({
          query: request.query,
          count: request.count,
        })}`,
      );
      const cached = readCache(GEMINI_SEARCH_CACHE, cacheKey);
      if (cached) return { ...cached.value, cached: true } as SearchProviderExecutionResult;
      const startedAt = Date.now();
      const result = await runGeminiSearch({
        query: request.query,
        apiKey,
        model,
        timeoutSeconds: ctx.timeoutSeconds,
      });
      const payload = {
        query: request.query,
        provider: "gemini",
        model,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "gemini",
          wrapped: true,
        },
        content: wrapWebContent(result.content),
        citations: result.citations,
      };
      writeCache(GEMINI_SEARCH_CACHE, cacheKey, payload, ctx.cacheTtlMs);
      return payload as SearchProviderExecutionResult;
    },
  };
}

export const __testing = {
  GEMINI_SEARCH_CACHE,
  clearSearchProviderCaches() {
    GEMINI_SEARCH_CACHE.clear();
  },
} as const;
