import { requireResponsesSearchTextCitationsAndInline } from "openclaw/plugin-sdk/provider-web-search";
import {
  requestXaiResponsesTool,
  resolveXaiToolDefaultReasoningEffort,
} from "./responses-tool-shared.js";

const XAI_WEB_SEARCH_MAX_CONTENT_CHARS = 20_000;

/** Typed deadline the web_search boundary reports as a timeout. */
class XaiWebSearchTimeoutError extends Error {
  override readonly name = "TimeoutError";
  readonly code = "ETIMEDOUT";
  readonly timeoutMs: number;

  constructor(timeoutSeconds: number, cause: Error) {
    super(
      `xAI web search timed out after ${timeoutSeconds}s. Check xAI authentication or try a simpler request.`,
      { cause },
    );
    this.timeoutMs = timeoutSeconds * 1_000;
  }
}

export function wrapXaiWebSearchError(error: unknown, timeoutSeconds: number): never {
  if (
    error instanceof Error &&
    !(error instanceof XaiWebSearchTimeoutError) &&
    (error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      error.message === "This operation was aborted")
  ) {
    throw new XaiWebSearchTimeoutError(timeoutSeconds, error);
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
      requireResponsesSearchTextCitationsAndInline(
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
