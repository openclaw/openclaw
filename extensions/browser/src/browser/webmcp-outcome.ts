import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { stripBrowserToolModelHints } from "./client-model-hints.js";

const WEBMCP_OUTCOME_UNKNOWN_MESSAGE =
  "WebMCP execution outcome unknown. Inspect the page before retrying.";

// Nodes and services on other versions may phrase retry guidance differently than this
// client's hint constants, so drop any remaining sentence that still advises a retry.
const RETRY_ADVICE_SENTENCE_RE = /[^.!?|]*\bretry the browser tool\b[^.!?|]*[.!?]?/gi;

/**
 * Replace a lost-response transport error with the unknown-outcome error. Agent and log
 * formatters print the whole cause graph, so the original error is not chained verbatim: its
 * flattened detail is kept as the cause with every retry hint removed.
 */
function webMcpOutcomeUnknownError(transportError: unknown): Error {
  const detail = stripBrowserToolModelHints(formatErrorMessage(transportError))
    .replace(RETRY_ADVICE_SENTENCE_RE, "")
    .replace(/^Error:\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return new Error(
    WEBMCP_OUTCOME_UNKNOWN_MESSAGE,
    detail && detail !== WEBMCP_OUTCOME_UNKNOWN_MESSAGE ? { cause: new Error(detail) } : undefined,
  );
}

/** Preserve mutation uncertainty when a caller loses the execution response. */
export async function withWebMcpOutcome<T>(
  action: "list" | "execute",
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (cause) {
    if (action === "list") {
      throw cause;
    }
    // Transport cancellation cannot undo page mutations. Never forward generic retry advice.
    throw webMcpOutcomeUnknownError(cause);
  }
}
