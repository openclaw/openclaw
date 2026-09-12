import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { stripBrowserToolModelHints } from "./client-model-hints.js";

const WEBMCP_OUTCOME_UNKNOWN_MESSAGE =
  "WebMCP execution outcome unknown. Inspect the page before retrying.";

// Nodes and services on other versions may phrase retry guidance differently than this
// client's hint constants, so drop any remaining sentence that still advises a retry.
const RETRY_ADVICE_SENTENCE_RE = /[^.!?|]*\bretry the browser tool\b[^.!?|]*[.!?]?/gi;

/** Keep structured failure identity without retaining original messages or cause objects. */
function sanitizedTransportCause(source: unknown, message: string): Error {
  const root = new Error(message);
  const copies = new Map<object, Error>();
  const pending = [{ source, target: root }];
  if (source && typeof source === "object") {
    copies.set(source, root);
  }
  // Match the bounded cause/reason/status traversal used by the tool error classifier.
  for (const { source: current, target } of pending) {
    if (!current || typeof current !== "object") {
      continue;
    }
    for (const key of ["name", "code", "reason", "status", "cause"] as const) {
      let value: unknown;
      try {
        value = Reflect.get(current, key);
      } catch {
        continue;
      }
      if (key !== "cause" && typeof value === "string") {
        // Identity tokens cannot carry prose or reintroduce stripped retry instructions.
        const token = key === "name" ? value : value.trim();
        if (/^[a-z0-9_]{1,128}$/i.test(token)) {
          Object.defineProperty(target, key, { value: token, configurable: true });
        }
      } else if (
        (key === "cause" || key === "reason" || key === "status") &&
        value &&
        typeof value === "object"
      ) {
        let copy = copies.get(value);
        if (!copy && copies.size < 8) {
          copy = new Error("");
          copies.set(value, copy);
          pending.push({ source: value, target: copy });
        }
        if (copy) {
          Object.defineProperty(target, key, { value: copy, configurable: true });
        }
      }
    }
  }
  return root;
}

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
  return new Error(WEBMCP_OUTCOME_UNKNOWN_MESSAGE, {
    cause: sanitizedTransportCause(
      transportError,
      detail === WEBMCP_OUTCOME_UNKNOWN_MESSAGE ? "" : detail,
    ),
  });
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
