import { wrapWebContent } from "openclaw/plugin-sdk/provider-web-search";
import {
  requestXaiResponsesTool,
  resolveXaiToolDefaultReasoningEffort,
  requireXaiResponseTextCitationsAndInline,
} from "./responses-tool-shared.js";
import type { XaiWebSearchResponse } from "./web-search-response.types.js";
export type { XaiWebSearchResponse } from "./web-search-response.types.js";

const XAI_WEB_SEARCH_MAX_CONTENT_CHARS = 20_000;

export function buildXaiWebSearchPayload(params: {
  query: string;
  provider: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
  truncated?: boolean;
  source?: "web_search" | "x_search";
}): Record<string, unknown> {
  return {
    query: params.query,
    provider: params.provider,
    model: params.model,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: params.source ?? "web_search",
      provider: params.provider,
      wrapped: true,
    },
    content: wrapWebContent(params.content, "web_search"),
    citations: params.citations,
    ...(params.inlineCitations ? { inlineCitations: params.inlineCitations } : {}),
    ...(params.truncated ? { truncated: true } : {}),
  };
}

export function wrapXaiWebSearchError(error: unknown, timeoutSeconds: number): never {
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      error.message === "This operation was aborted")
  ) {
    throw Object.assign(
      new Error(
        `xAI web search timed out after ${timeoutSeconds}s. Check xAI authentication or try a simpler request.`,
        { cause: error },
      ),
      { code: "ETIMEDOUT" },
    );
  }
  throw error;
}

export async function requestXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  endpoint: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
  signal?: AbortSignal;
}) {
  params.signal?.throwIfAborted();
  return await requestXaiResponsesTool(
    {
      ...params,
      inputText: params.query,
      tools: [{ type: "web_search" }],
      reasoningEffort: resolveXaiToolDefaultReasoningEffort(params.model, "low"),
      errorLabel: "xAI web search failed",
    },
    (data) =>
      requireXaiResponseTextCitationsAndInline(
        data,
        "xAI web search failed",
        params.inlineCitations,
        XAI_WEB_SEARCH_MAX_CONTENT_CHARS,
      ),
  ).catch((error: unknown) => {
    if (params.signal?.aborted && error === params.signal.reason) {
      throw error;
    }
    return wrapXaiWebSearchError(error, params.timeoutSeconds);
  });
}
