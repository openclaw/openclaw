/**
 * Structured tool result envelope for OpenClaw agents.
 *
 * Adds a lightweight contract layer on top of raw tool outputs so the model
 * receives consistent, machine-readable result shapes. This does NOT change
 * how existing tools are registered or executed — it is an opt-in wrapper
 * that callers can use when building new tools or wrapping raw results.
 *
 * Learned from: Claude Code tools/src/lib.rs ToolSpec pattern.
 */

/** Discriminated union for successful tool results. */
export type AgentToolResultOk<T = unknown> = {
  ok: true;
  /** One-sentence summary of what the tool produced. */
  summary: string;
  /** The primary payload — JSON-serializable. */
  data: T;
  /** Provenance of the data (URLs, file paths, API names, etc.). */
  sources: string[];
  /** Hint for the model on how to use this result next. */
  next_hint?: string;
};

/** Error category codes aligned with the doc's failure taxonomy. */
export type AgentToolErrorCode =
  | "temporary" // network / timeout / service unavailable
  | "input_error" // bad params, missing fields, wrong format
  | "permission_or_auth" // auth/session failure at tool execution level
  | "not_found" // resource not found
  | "tool_bug"; // unexpected internal tool failure

/** Discriminated union for failed tool results. */
export type AgentToolResultError = {
  ok: false;
  error: {
    code: AgentToolErrorCode;
    message: string;
    /** True when the caller may safely retry with adjusted parameters. */
    retryable: boolean;
  };
  /** Any partial data successfully collected before the failure. */
  partial_data?: unknown;
  /** Hint for the model on how to recover. */
  next_hint?: string;
};

/** Union of success and error envelopes. */
export type AgentToolResult<T = unknown> = AgentToolResultOk<T> | AgentToolResultError;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Wrap a successful tool output in the structured envelope. */
export function wrapToolOk<T>(params: {
  summary: string;
  data: T;
  sources?: string[];
  next_hint?: string;
}): AgentToolResultOk<T> {
  return {
    ok: true,
    summary: params.summary,
    data: params.data,
    sources: params.sources ?? [],
    next_hint: params.next_hint,
  };
}

/** Wrap a tool failure in the structured envelope. */
export function wrapToolError(params: {
  code: AgentToolErrorCode;
  message: string;
  retryable: boolean;
  partial_data?: unknown;
  next_hint?: string;
}): AgentToolResultError {
  return {
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable,
    },
    partial_data: params.partial_data,
    next_hint: params.next_hint,
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a raw error (string or Error) into an AgentToolErrorCode.
 *
 * This is a heuristic helper — callers that know the concrete failure reason
 * should pass the code directly to `wrapToolError` instead.
 */
export function classifyToolError(err: unknown): AgentToolErrorCode {
  const msg = extractErrorMessage(err).toLowerCase();

  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("unavailable") ||
    msg.includes("503") ||
    msg.includes("502")
  ) {
    return "temporary";
  }
  if (
    msg.includes("not found") ||
    msg.includes("404") ||
    msg.includes("no such") ||
    msg.includes("does not exist")
  ) {
    return "not_found";
  }
  if (
    msg.includes("permission") ||
    msg.includes("forbidden") ||
    msg.includes("403") ||
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("auth") ||
    msg.includes("token")
  ) {
    return "permission_or_auth";
  }
  if (
    msg.includes("invalid") ||
    msg.includes("bad request") ||
    msg.includes("400") ||
    msg.includes("required") ||
    msg.includes("parameter") ||
    msg.includes("schema")
  ) {
    return "input_error";
  }
  return "tool_bug";
}

/** Determine whether an error code is retryable. */
export function isRetryableErrorCode(code: AgentToolErrorCode): boolean {
  return code === "temporary";
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize an AgentToolResult to the compact text representation that should
 * be placed in the tool_result content block sent back to the model.
 *
 * Success: plain JSON of the envelope.
 * Failure: JSON with the error field prominently at the top.
 */
export function serializeToolResult(result: AgentToolResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
