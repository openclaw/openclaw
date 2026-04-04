/**
 * Provider-owned error-pattern dispatch plus legacy fallback patterns.
 *
 * Most provider-specific failover classification now lives on provider-plugin
 * hooks. This module keeps only fallback patterns for providers that do not
 * yet ship a dedicated provider plugin hook surface.
 */

import {
  classifyProviderFailoverReasonWithPlugin,
  matchesProviderContextOverflowWithPlugin,
} from "../../plugins/provider-runtime.js";
import type { FailoverReason } from "./types.js";

type ProviderErrorPattern = {
  /** Regex to match against the raw error message. */
  test: RegExp;
  /** The failover reason this pattern maps to. */
  reason: FailoverReason;
};

/**
 * Provider-specific context overflow patterns not covered by the generic
 * `isContextOverflowError()` in errors.ts. Called from `isContextOverflowError()`
 * to catch provider-specific wording that the generic regex misses.
 */
export const PROVIDER_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  // AWS Bedrock validation / stream errors use provider-specific wording.
  /\binput token count exceeds the maximum number of input tokens\b/i,
  /\binput is too long for this model\b/i,

  // Google Vertex / Gemini REST surfaces this wording.
  /\binput exceeds the maximum number of tokens\b/i,

  // Ollama may append a provider prefix and extra token wording.
  /\bollama error:\s*context length exceeded(?:,\s*too many tokens)?\b/i,

  // Cohere does not currently ship a bundled provider hook.
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i,

  // Generic "input too long" pattern that isn't covered by existing checks
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

/**
 * Provider-specific patterns that map to specific failover reasons.
 * These handle cases where the generic classifiers in failover-matches.ts
 * produce wrong results for specific providers.
 */
export const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[] = [
  {
    test: /\bthrottlingexception\b/i,
    reason: "rate_limit",
  },
  {
    test: /\bconcurrency limit(?: has been)? reached\b/i,
    reason: "rate_limit",
  },
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

/**
 * Check if an error message matches any provider-specific context overflow pattern.
 * Called from `isContextOverflowError()` to catch provider-specific wording.
 */
export function matchesProviderContextOverflow(errorMessage: string): boolean {
  return (
    matchesProviderContextOverflowWithPlugin({
      context: { errorMessage },
    }) || PROVIDER_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))
  );
}

/**
 * Try to classify an error using provider-specific patterns.
 * Returns null if no provider-specific pattern matches (fall through to generic classification).
 */
export function classifyProviderSpecificError(errorMessage: string): FailoverReason | null {
  const pluginReason = classifyProviderFailoverReasonWithPlugin({
    context: { errorMessage },
  });
  if (pluginReason) {
    return pluginReason;
  }
  for (const pattern of PROVIDER_SPECIFIC_PATTERNS) {
    if (pattern.test.test(errorMessage)) {
      return pattern.reason;
    }
  }
  return null;
}
