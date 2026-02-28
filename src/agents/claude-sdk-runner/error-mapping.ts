/**
 * Error Mapping: Claude Agent SDK → OpenClaw Error Classification
 *
 * Translates Claude Agent SDK error types into errors whose messages/names
 * pass through the existing Pi error classification functions in pi-embedded-helpers.ts.
 *
 * Strategy: Catch SDK errors in the adapter's prompt() method and re-throw with
 * error.message / error.name values that pass through existing classification functions.
 * This avoids modifying any error classification code.
 *
 * Note: prompt() exceptions are classified via message-based checks in
 * pi-embedded-runner/run.ts (describeUnknownError + classifyFailoverReason /
 * isFailoverErrorMessage), not AssistantMessage.stopReason checks.
 *
 * Classification function targets (from pi-embedded-helpers.ts):
 *   isTimeoutError()               — looks for name="TimeoutError" or message contains "timed out"
 *   isAuthAssistantError()         — looks for 401 / "authentication" in message
 *   isBillingAssistantError()      — looks for billing/quota keywords
 *   isRateLimitAssistantError()    — looks for 429 / "rate_limit" in message
 *   isFailoverAssistantError()     — looks for 5xx / "connection" errors
 *   isLikelyContextOverflowError() — looks for context-overflow keywords
 *   isRunnerAbortError()           — looks for name="AbortError" (already runtime-agnostic)
 */

/**
 * Wraps a Claude Agent SDK error into a form that passes through the existing
 * Pi error classification functions. Returns a new Error with the appropriate
 * name and message, or the original error if no mapping applies.
 */
const STALE_RESUME_HINTS = [
  "resume",
  "session not found",
  "invalid session",
  "unknown session",
  "session expired",
];

export function isStaleClaudeResumeSessionErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  if (!normalized.includes("session")) {
    return false;
  }
  return STALE_RESUME_HINTS.some((hint) => normalized.includes(hint));
}

export function isStaleClaudeResumeSessionError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return isStaleClaudeResumeSessionErrorMessage(err.message);
}

export function mapSdkError(err: unknown): unknown {
  if (!(err instanceof Error)) {
    return err;
  }

  const errName = err.name ?? "";
  const errMsg = (err.message ?? "").toLowerCase();

  // AbortError — already runtime-agnostic, pass through as-is
  if (errName === "AbortError") {
    return err;
  }

  if (isStaleClaudeResumeSessionError(err)) {
    return createMappedError(
      `claude_sdk_stale_resume_session: ${err.message || "resume session is stale or invalid"}`,
      "AssistantError",
      err,
    );
  }

  // TimeoutError (APIConnectionTimeoutError)
  if (
    errName === "APIConnectionTimeoutError" ||
    errName === "TimeoutError" ||
    errMsg.includes("timeout") ||
    errMsg.includes("timed out")
  ) {
    return createMappedError("request timed out", "TimeoutError", err);
  }

  // AuthenticationError (401)
  if (
    errName === "AuthenticationError" ||
    errMsg.includes("authentication") ||
    errMsg.includes("401")
  ) {
    return createMappedError(
      "authentication_error: Invalid API key or authorization",
      "AssistantError",
      err,
    );
  }

  // RateLimitError (429)
  if (errName === "RateLimitError" || errMsg.includes("rate_limit") || errMsg.includes("429")) {
    return createMappedError("rate_limit_error: Too many requests", "AssistantError", err);
  }

  // BadRequestError that looks like context overflow
  if (
    errName === "BadRequestError" &&
    (errMsg.includes("context") ||
      errMsg.includes("token") ||
      errMsg.includes("too long") ||
      errMsg.includes("maximum") ||
      errMsg.includes("input length") ||
      errMsg.includes("prompt is too long"))
  ) {
    return createMappedError(
      "prompt_too_long: Input exceeds context window limit",
      "AssistantError",
      err,
    );
  }

  // PermissionDeniedError (403) — model access restricted or forbidden
  const status = (err as { status?: number }).status;
  if (errName === "PermissionDeniedError" || status === 403) {
    return createMappedError(
      "permission_denied: Access denied — check model permissions or API key scope",
      "AssistantError",
      err,
    );
  }

  // NotFoundError (404) — invalid model ID or endpoint
  if (errName === "NotFoundError" || status === 404) {
    return createMappedError(
      `not_found_error: Resource not found — ${err.message || "check model ID and endpoint"}`,
      "AssistantError",
      err,
    );
  }

  // UnprocessableEntityError (422) — malformed request
  if (errName === "UnprocessableEntityError" || status === 422) {
    return createMappedError(
      `invalid_request_error: Unprocessable request — ${err.message || "check request parameters"}`,
      "AssistantError",
      err,
    );
  }

  // APIError 5xx (server errors → failover)
  if (
    errName === "APIConnectionError" ||
    errName === "APIError" ||
    (typeof status === "number" && status >= 500)
  ) {
    return createMappedError(
      `overloaded_error: API error ${status ?? "unknown"} — transient failure`,
      "AssistantError",
      err,
    );
  }

  // Unknown billing / quota errors
  if (errMsg.includes("billing") || errMsg.includes("quota") || errMsg.includes("payment")) {
    return createMappedError("billing_error: Account billing issue", "AssistantError", err);
  }

  // Pass through other errors as-is
  return err;
}

function createMappedError(message: string, name: string, cause: Error): Error {
  const mapped = new Error(message, { cause });
  mapped.name = name;
  return mapped;
}
