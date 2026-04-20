import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveCitationRedirectUrl,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  resolveGeminiApiType,
  resolveGeminiBaseUrl,
  resolveGeminiConfig,
  resolveGeminiModel,
  type GeminiConfig,
} from "./gemini-web-search-provider.shared.js";

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

type OpenAICompatibleChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  grounding_metadata?: {
    groundingChunks?: Array<{
      web?: {
        uri?: string;
        title?: string;
      };
    }>;
  };
  error?: {
    message?: string;
  };
};

export function resolveGeminiRuntimeApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "tools.web.search.gemini.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY", "GOOGLE_API_KEY"])
  );
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  apiType: "gemini" | "openai-compatible";
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");

  if (params.apiType === "openai-compatible") {
    const endpoint = `${baseUrl}/chat/completions`;
    return withTrustedWebSearchEndpoint(
      {
        url: endpoint,
        timeoutSeconds: params.timeoutSeconds,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages: [{ role: "user", content: params.query }],
            tools: [{ google_search: {} }],
          }),
        },
      },
      async (res) => {
        if (!res.ok) {
          const detail = (await res.text()) || res.statusText;
          throw new Error(`OpenAI-compatible API error (${res.status}) at ${endpoint}: ${detail}`);
        }
        const data = (await res.json()) as OpenAICompatibleChatResponse;
        if (data.error) {
          throw new Error(`API error: ${data.error.message}`);
        }

        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? "No response";
        const rawCitations = (data.grounding_metadata?.groundingChunks ?? [])
          .filter((chunk) => chunk.web?.uri)
          .map((chunk) => ({
            url: chunk.web!.uri!,
            title: chunk.web?.title || undefined,
          }));

        const citations: Array<{ url: string; title?: string }> = [];
        for (const citation of rawCitations) {
          citations.push({
            ...citation,
            url: await resolveCitationRedirectUrl(citation.url),
          });
        }
        return { content, citations };
      },
    );
  }

  const endpoint = `${baseUrl}/models/${params.model}:generateContent`;
  return withTrustedWebSearchEndpoint(
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
    async (res) => {
      if (!res.ok) {
        const safeDetail = ((await res.text()) || res.statusText).replace(
          /key=[^&\s]+/giu,
          "key=***",
        );
        throw new Error(`Gemini API error (${res.status}) at ${endpoint}: ${safeDetail}`);
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (error) {
        const safeError = String(error).replace(/key=[^&\s]+/giu, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: error });
      }

      if (data.error) {
        const rawMessage = data.error.message || data.error.status || "unknown";
        throw new Error(
          `Gemini API error (${data.error.code}) at ${endpoint}: ${rawMessage.replace(/key=[^&\s]+/giu, "key=***")}`,
        );
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((part) => part.text)
          .filter(Boolean)
          .join("\n") ?? "No response";
      const rawCitations = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));

      const citations: Array<{ url: string; title?: string }> = [];
      for (let index = 0; index < rawCitations.length; index += 10) {
        const batch = rawCitations.slice(index, index + 10);
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

export async function executeGeminiSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const unsupportedResponse = buildUnsupportedSearchFilterResponse(args, "gemini");
  if (unsupportedResponse) {
    return unsupportedResponse;
  }

  const geminiConfig = resolveGeminiConfig(searchConfig);
  const apiKey = resolveGeminiRuntimeApiKey(geminiConfig);
  if (!apiKey) {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const model = resolveGeminiModel(geminiConfig);
  const baseUrl = resolveGeminiBaseUrl(geminiConfig);
  const apiType = resolveGeminiApiType(geminiConfig);
  const cacheKey = buildSearchCacheKey([
    "gemini",
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    model,
    baseUrl,
    apiType,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const result = await runGeminiSearch({
    query,
    apiKey,
    baseUrl,
    model,
    apiType,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
  });
  const payload = {
    query,
    provider: "gemini",
    model,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "gemini",
      wrapped: true,
    },
    content: wrapWebContent(result.content),
    citations: result.citations,
  };
  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}
