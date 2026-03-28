import { postTrustedWebToolsJson, wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";
import { normalizeXaiModelId } from "../api.js";

export const XAI_WEB_SEARCH_ENDPOINT = "https://api.x.ai/v1/responses";
export const XAI_DEFAULT_WEB_SEARCH_MODEL = "grok-4-1-fast";

export type XaiWebSearchResponse = {
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
};

export type XaiWebSearchResult = {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
};

export function buildXaiWebSearchPayload(params: {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resolveXaiSearchConfig(searchConfig?: Record<string, unknown>): XaiWebSearchConfig {
  return (asRecord(searchConfig?.grok) as XaiWebSearchConfig | undefined) ?? {};
}

export function resolveXaiWebSearchModel(searchConfig?: Record<string, unknown>): string {
  const config = resolveXaiSearchConfig(searchConfig);
  return typeof config.model === "string" && config.model.trim()
    ? normalizeXaiModelId(config.model.trim())
    : XAI_DEFAULT_WEB_SEARCH_MODEL;
}

export function resolveXaiInlineCitations(searchConfig?: Record<string, unknown>): boolean {
  return resolveXaiSearchConfig(searchConfig).inlineCitations === true;
}

export function extractXaiWebSearchContent(data: XaiWebSearchResponse): {
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

export async function requestXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<XaiWebSearchResult> {
  return await postTrustedWebToolsJson(
    {
      url: XAI_WEB_SEARCH_ENDPOINT,
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

export const __testing = {
  buildXaiWebSearchPayload,
  extractXaiWebSearchContent,
  resolveXaiInlineCitations,
  resolveXaiSearchConfig,
  resolveXaiWebSearchModel,
  requestXaiWebSearch,
  XAI_DEFAULT_WEB_SEARCH_MODEL,
} as const;
