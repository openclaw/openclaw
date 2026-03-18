import { Type } from "@sinclair/typebox";
import { readNumberParam, readStringParam } from "../../../src/agents/tools/common.js";
import { resolveCitationRedirectUrl } from "../../../src/agents/tools/web-search-citation-redirect.js";
import type { SearchConfigRecord } from "../../../src/agents/tools/web-search-provider-common.js";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  writeCachedSearchPayload,
} from "../../../src/agents/tools/web-search-provider-common.js";
import type {
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "../../../src/plugins/types.js";
import { wrapWebContent } from "../../../src/security/external-content.js";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

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

function resolveGeminiConfig(searchConfig?: SearchConfigRecord): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return gemini && typeof gemini === "object" && !Array.isArray(gemini)
    ? (gemini as GeminiConfig)
    : {};
}

function resolveGeminiApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "tools.web.search.gemini.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY"])
  );
}

function resolveGeminiModel(gemini?: GeminiConfig): string {
  const model = typeof gemini?.model === "string" ? gemini.model.trim() : "";
  return model || DEFAULT_GEMINI_MODEL;
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${GEMINI_API_BASE}/models/${params.model}:generateContent`;

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
          /key=[^&\s]+/gi,
          "key=***",
        );
        throw new Error(`Gemini API error (${res.status}): ${safeDetail}`);
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (error) {
        const safeError = String(error).replace(/key=[^&\s]+/gi, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: error });
      }

      if (data.error) {
        const rawMessage = data.error.message || data.error.status || "unknown";
        throw new Error(
          `Gemini API error (${data.error.code}): ${rawMessage.replace(/key=[^&\s]+/gi, "key=***")}`,
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

function createGeminiSchema() {
  return Type.Object({
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    language: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    freshness: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    date_after: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
    date_before: Type.Optional(Type.String({ description: "Not supported by Gemini." })),
  });
}

function createGeminiToolDefinition(
  searchConfig?: SearchConfigRecord,
): WebSearchProviderToolDefinition {
  return {
    description:
      "Search the web using Gemini with Google Search grounding. Returns AI-synthesized answers with citations from Google Search.",
    parameters: createGeminiSchema(),
    execute: async (args) => {
      const params = args as Record<string, unknown>;
      for (const name of ["country", "language", "freshness", "date_after", "date_before"]) {
        if (readStringParam(params, name)) {
          const label =
            name === "country"
              ? "country filtering"
              : name === "language"
                ? "language filtering"
                : name === "freshness"
                  ? "freshness filtering"
                  : "date_after/date_before filtering";
          return {
            error: name.startsWith("date_") ? "unsupported_date_filter" : `unsupported_${name}`,
            message: `${label} is not supported by the gemini provider. Only Brave and Perplexity support ${name === "country" ? "country filtering" : name === "language" ? "language filtering" : name === "freshness" ? "freshness" : "date filtering"}.`,
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }
      }

      const geminiConfig = resolveGeminiConfig(searchConfig);
      const apiKey = resolveGeminiApiKey(geminiConfig);
      if (!apiKey) {
        return {
          error: "missing_gemini_api_key",
          message:
            "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
          docs: "https://docs.openclaw.ai/tools/web",
        };
      }

      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ??
        searchConfig?.maxResults ??
        undefined;
      const model = resolveGeminiModel(geminiConfig);
      const cacheKey = buildSearchCacheKey([
        "gemini",
        query,
        resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        model,
      ]);
      const cached = readCachedSearchPayload(cacheKey);
      if (cached) {
        return cached;
      }

      const start = Date.now();
      const result = await runGeminiSearch({
        query,
        apiKey,
        model,
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
    },
  };
}

export function createGeminiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "gemini",
    label: "Gemini (Google Search)",
    hint: "Google Search grounding · AI-synthesized",
    envVars: ["GEMINI_API_KEY"],
    placeholder: "AIza...",
    signupUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 20,
    credentialPath: "tools.web.search.gemini.apiKey",
    inactiveSecretPaths: ["tools.web.search.gemini.apiKey"],
    getCredentialValue: (searchConfig) => {
      const gemini = searchConfig?.gemini;
      return gemini && typeof gemini === "object" && !Array.isArray(gemini)
        ? (gemini as Record<string, unknown>).apiKey
        : undefined;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const scoped = searchConfigTarget.gemini;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
        searchConfigTarget.gemini = { apiKey: value };
        return;
      }
      (scoped as Record<string, unknown>).apiKey = value;
    },
    createTool: (ctx) =>
      createGeminiToolDefinition(ctx.searchConfig as SearchConfigRecord | undefined),
  };
}

export const __testing = {
  resolveGeminiApiKey,
  resolveGeminiModel,
} as const;
