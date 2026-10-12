import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  hasRateLimitTpmHint,
  isContextOverflowErrorFromTables,
  isReasoningConstraintErrorMessage,
  looksLikeProviderContextOverflowCandidate,
} from "./context-overflow-tables.js";
import {
  isBillingErrorMessage,
  isProviderRequestSizeCeilingError,
  isRateLimitErrorMessage,
} from "./message-patterns.js";
import {
  classifyProviderPluginError,
  type PreparedProviderFailoverOwner,
} from "./provider-patterns.js";

export function isContextOverflowError(
  errorMessage?: string,
  opts?: { providerPlugin?: PreparedProviderFailoverOwner | null },
): boolean {
  if (!errorMessage) {
    return false;
  }
  return (
    isContextOverflowErrorFromTables(errorMessage) ||
    (looksLikeProviderContextOverflowCandidate(errorMessage) &&
      classifyProviderPluginError({ errorMessage, providerPlugin: opts?.providerPlugin }) ===
        "context_overflow")
  );
}

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Settle an unsatisfiable request size first: the TPM and rate-limit exclusions below would
  // otherwise claim the message on its rate-limit wording alone.
  if (isProviderRequestSizeCeilingError(errorMessage)) {
    return isContextOverflowErrorFromTables(errorMessage);
  }

  // Quota, billing, and reasoning failures can contain the same broad token-limit
  // wording; exclude them before consulting the overflow heuristic or provider.
  if (
    hasRateLimitTpmHint(errorMessage) ||
    isReasoningConstraintErrorMessage(errorMessage) ||
    isBillingErrorMessage(errorMessage) ||
    matchesContextOverflowMessage(errorMessage, "context-window-too-small") ||
    isRateLimitErrorMessage(errorMessage)
  ) {
    return false;
  }
  return (
    isContextOverflowError(errorMessage) ||
    (!normalizeLowercaseStringOrEmpty(errorMessage).includes("prompt template") &&
      !matchesContextOverflowMessage(errorMessage, "rate-limit-hint") &&
      matchesContextOverflowMessage(errorMessage, "failover-hint"))
  );
}
