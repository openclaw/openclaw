import type { classifyProviderPluginError } from "./provider-patterns.js";
import type { FailoverReason } from "./signal.js";
type ProviderErrorPattern = {
  /** Regex to match against the raw error message. */
  test: RegExp;
  /** The failover reason this pattern maps to. */
  reason: FailoverReason;
};
/**
 * Provider-specific patterns that map to specific failover reasons.
 * These handle cases where the generic message tables produce wrong results
 * for specific providers.
 */
const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[] = [
  {
    test: /\bworkers_ai\b.*\bquota limit exceeded\b/i,
    reason: "rate_limit",
  },
  {
    test: /\bmodelnotreadyexception\b/i,
    reason: "overloaded",
  },
  // Groq does not currently ship a bundled provider hook.
  {
    test: /model(?:_is)?_deactivated|model has been deactivated/i,
    reason: "model_not_found",
  },
];

export function classifyLegacyProviderSpecificError(
  context: Parameters<typeof classifyProviderPluginError>[0],
): FailoverReason | null {
  for (const pattern of PROVIDER_SPECIFIC_PATTERNS) {
    if (pattern.test.test(context.errorMessage)) {
      return pattern.reason;
    }
  }
  return null;
}
