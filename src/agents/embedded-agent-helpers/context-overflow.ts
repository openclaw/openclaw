import { isConfiguredContextSizeOverflowError } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isBillingErrorMessage, isRateLimitErrorMessage } from "./failover-matches.js";
import { matchesProviderContextOverflow } from "./provider-error-patterns.js";

/** Detect provider errors that require reasoning to stay enabled. */
export function isReasoningConstraintErrorMessage(raw: string): boolean {
  if (!raw) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return (
    lower.includes("reasoning is mandatory") ||
    lower.includes("reasoning is required") ||
    lower.includes("requires reasoning") ||
    (lower.includes("reasoning") && lower.includes("cannot be disabled"))
  );
}

function hasRateLimitTpmHint(raw: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}

/** Detect explicit context-window overflow without confusing TPM rate limits. */
export function isContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(errorMessage);

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  const hasRequestSizeExceeds = lower.includes("request size exceeds");
  const hasContextWindow =
    lower.includes("context window") ||
    lower.includes("context length") ||
    lower.includes("maximum context length");
  const hasContextWindowOutOfRoom =
    hasContextWindow && (lower.includes("ran out of room") || lower.includes("ran out of space"));
  return (
    lower.includes("request_too_large") ||
    lower.includes("context_overflow") ||
    isConfiguredContextSizeOverflowError(errorMessage) ||
    (lower.includes("invalid_argument") && lower.includes("maximum number of tokens")) ||
    lower.includes("request exceeds the maximum size") ||
    lower.includes("context length exceeded") ||
    lower.includes("maximum context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("prompt too long") ||
    lower.includes("exceeds model context window") ||
    lower.includes("model token limit") ||
    (lower.includes("input exceeds") && lower.includes("maximum number of tokens")) ||
    hasContextWindowOutOfRoom ||
    (hasRequestSizeExceeds && hasContextWindow) ||
    lower.includes("context overflow:") ||
    lower.includes("exceed context limit") ||
    lower.includes("exceeds the model's maximum context") ||
    (lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("input length") && lower.includes("exceed") && lower.includes("context")) ||
    (lower.includes("413") && lower.includes("too large")) ||
    // Anthropic API and OpenAI-compatible providers (e.g. ZhipuAI/GLM) return this stop reason
    // when the context window is exceeded. shared model runtime surfaces it as "Unhandled stop reason: model_context_window_exceeded".
    lower.includes("context_window_exceeded") ||
    // Chinese proxy error messages for context overflow
    errorMessage.includes("上下文过长") ||
    errorMessage.includes("上下文超出") ||
    errorMessage.includes("上下文长度超") ||
    errorMessage.includes("超出最大上下文") ||
    errorMessage.includes("请压缩上下文") ||
    // Provider-specific patterns (Bedrock, Azure, Ollama, Mistral, Cohere, etc.)
    matchesProviderContextOverflow(errorMessage)
  );
}

const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE =
  /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;
const RATE_LIMIT_HINT_RE =
  /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i;

/**
 * Detects Anthropic's 429 "Extra usage is required for long context requests." error.
 *
 * Anthropic returns HTTP 429 for this case, but it is semantically a context overflow
 * (the session is too large for the standard usage tier), not a transient rate limit.
 * It should be routed to the compact+retry path instead of the model fallback chain.
 */
function isAnthropicLongContextUsageError(errorMessage: string): boolean {
  return normalizeLowercaseStringOrEmpty(errorMessage).includes(
    "extra usage is required for long context",
  );
}

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context overflow.
  if (hasRateLimitTpmHint(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  // Anthropic returns HTTP 429 for "Extra usage is required for long context requests."
  // The semantically correct recovery is compact + retry on the standard tier, not
  // billing-style "out of credits" handling - the request is rejected because the
  // session is too large for the standard usage tier, not because credits are out.
  // Check here, before isBillingErrorMessage, because the billing classifier matches
  // "extra usage is required" via failover-matches.ts and would otherwise short-circuit.
  if (isAnthropicLongContextUsageError(errorMessage)) {
    return true;
  }

  // Billing/quota errors can contain patterns like "request size exceeds" or
  // "maximum token limit exceeded" that match the context overflow heuristic.
  // Billing is a more specific error class - exclude it early.
  if (isBillingErrorMessage(errorMessage)) {
    return false;
  }

  if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) {
    return false;
  }
  // Rate limit errors can match the broad CONTEXT_OVERFLOW_HINT_RE pattern
  // (e.g., "request reached organization TPD rate limit" matches request.*limit).
  // Exclude them before checking context overflow heuristics.
  if (isRateLimitErrorMessage(errorMessage)) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return true;
  }
  if (RATE_LIMIT_HINT_RE.test(errorMessage)) {
    return false;
  }
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}
