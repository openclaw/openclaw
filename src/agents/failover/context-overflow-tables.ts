import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isProviderRequestSizeCeilingError, isRateLimitErrorMessage } from "./message-patterns.js";

const PROVIDER_CONTEXT_OVERFLOW_SIGNAL_RE =
  /\b(?:context|window|prompt|token|tokens|input|request|model)\b/i;
const PROVIDER_CONTEXT_OVERFLOW_ACTION_RE =
  /\b(?:too\s+(?:large|long|many)|exceed(?:s|ed|ing)?|overflow|limit|maximum|max)\b/i;

export function looksLikeProviderContextOverflowCandidate(errorMessage: string): boolean {
  return (
    !isRateLimitErrorMessage(errorMessage) &&
    PROVIDER_CONTEXT_OVERFLOW_SIGNAL_RE.test(errorMessage) &&
    PROVIDER_CONTEXT_OVERFLOW_ACTION_RE.test(errorMessage)
  );
}

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

export function hasRateLimitTpmHint(raw: string): boolean {
  return matchesContextOverflowMessage(raw, "tpm-rate-limit-hint");
}

/** Detect explicit context-window overflow without confusing TPM rate limits. */
export function isContextOverflowErrorFromTables(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }
  // Groq uses 413 for TPM (tokens per minute) limits, which is a rate limit, not context
  // overflow — unless the request alone exceeds the whole limit, which no wait can satisfy.
  if (hasRateLimitTpmHint(errorMessage) && !isProviderRequestSizeCeilingError(errorMessage)) {
    return false;
  }

  if (isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }

  return (
    matchesContextOverflowMessage(errorMessage, "failover-explicit") ||
    (looksLikeProviderContextOverflowCandidate(errorMessage) &&
      matchesContextOverflowMessage(errorMessage, "provider-fallback"))
  );
}
