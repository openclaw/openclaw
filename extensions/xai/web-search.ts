import { Type } from "@sinclair/typebox";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  getScopedCredentialValue,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  resolveWebSearchProviderCredential,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
  withTrustedWebToolsEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";

const XAI_WEB_SEARCH_ENDPOINT = "https://api.x.ai/v1/responses";
const XAI_DEFAULT_WEB_SEARCH_MODEL = "grok-4-1-fast";
const XAI_WEB_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveXaiWebSearchConfig(
  searchConfig?: Record<string, unknown>,
): Record<string, unknown> {
  return asRecord(searchConfig?.grok) ?? {};
}

function resolveXaiWebSearchModel(searchConfig?: Record<string, unknown>): string {
  const config = resolveXaiWebSearchConfig(searchConfig);
  return typeof config.model === "string" && config.model.trim()
    ? config.model.trim()
    : XAI_DEFAULT_WEB_SEARCH_MODEL;
}

function resolveXaiInlineCitations(searchConfig?: Record<string, unknown>): boolean {
  return resolveXaiWebSearchConfig(searchConfig).inlineCitations === true;
}

function readQuery(args: Record<string, unknown>): string {
  const value = typeof args.query === "string" ? args.query.trim() : "";
  if (!value) {
    throw new Error("query required");
  }
  return value;
}

function readCount(args: Record<string, unknown>): number {
  const raw = args.count;
  const parsed =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number.parseFloat(raw)
        : 5;
  return Math.max(1, Math.min(10, Math.trunc(parsed)));
}

async function throwXaiWebSearchApiError(res: Response): Promise<never> {
  const detailResult = await readResponseText(res, { maxBytes: 64_000 });
  throw new Error(`xAI API error (${res.status}): ${detailResult.text || res.statusText}`);
}

async function runXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  cacheTtlMs: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `grok:${params.model}:${String(params.inlineCitations)}:${params.query}`,
  );
  const cached = readCache(XAI_WEB_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();
  const payload = await withTrustedWebToolsEndpoint(
    {
      url: XAI_WEB_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model: params.model,
          input: [{ role: "user", content: params.query }],
          tools: [{ type: "web_search" }],
        }),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        return await throwXaiWebSearchApiError(response);
      }

      const data = (await response.json()) as XaiWebSearchResponse;
      const { text, annotationCitations } = extractXaiWebSearchContent(data);
      const citations =
        Array.isArray(data.citations) && data.citations.length > 0
          ? data.citations
          : annotationCitations;

      return {
        query: params.query,
        provider: "grok",
        model: params.model,
        tookMs: Date.now() - startedAt,
        externalContent: {
          untrusted: true,
          source: "web_search",
          provider: "grok",
          wrapped: true,
        },
        content: wrapWebContent(text ?? "No response", "web_search"),
        citations,
        ...(params.inlineCitations && Array.isArray(data.inline_citations)
          ? { inlineCitations: data.inline_citations }
          : {}),
      };
    },
  );

  writeCache(XAI_WEB_SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createXaiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "grok",
    label: "Grok (xAI)",
    hint: "xAI web-grounded responses",
    envVars: ["XAI_API_KEY"],
    placeholder: "xai-...",
    signupUrl: "https://console.x.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 30,
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.xai.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig?: Record<string, unknown>) =>
      getScopedCredentialValue(searchConfig, "grok"),
    setCredentialValue: (searchConfigTarget: Record<string, unknown>, value: unknown) =>
      setScopedCredentialValue(searchConfigTarget, "grok", value),
    createTool: (ctx: { searchConfig?: Record<string, unknown> }) => ({
      description:
        "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string." }),
        count: Type.Optional(
          Type.Number({
            description: "Number of results to return (1-10).",
            minimum: 1,
            maximum: 10,
          }),
        ),
      }),
      execute: async (args: Record<string, unknown>) => {
        const apiKey = resolveWebSearchProviderCredential({
          credentialValue: getScopedCredentialValue(ctx.searchConfig, "grok"),
          path: "tools.web.search.grok.apiKey",
          envVars: ["XAI_API_KEY"],
        });

        if (!apiKey) {
          return {
            error: "missing_xai_api_key",
            message:
              "web_search (grok) needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
            docs: "https://docs.openclaw.ai/tools/web",
          };
        }

        const query = readQuery(args);
        const count = readCount(args);
        return await runXaiWebSearch({
          query,
          model: resolveXaiWebSearchModel(ctx.searchConfig),
          apiKey,
          timeoutSeconds: resolveTimeoutSeconds(
            (ctx.searchConfig?.timeoutSeconds as number | undefined) ?? undefined,
            DEFAULT_TIMEOUT_SECONDS,
          ),
          inlineCitations: resolveXaiInlineCitations(ctx.searchConfig),
          cacheTtlMs: resolveCacheTtlMs(
            (ctx.searchConfig?.cacheTtlMinutes as number | undefined) ?? undefined,
            DEFAULT_CACHE_TTL_MINUTES,
          ),
        });
      },
    }),
  };
}

export const __testing = {
  extractXaiWebSearchContent,
  resolveXaiWebSearchModel,
  resolveXaiInlineCitations,
};
