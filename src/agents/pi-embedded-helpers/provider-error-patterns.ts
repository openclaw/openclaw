/**
 * Provider-specific error patterns that improve failover classification accuracy.
 *
 * Many providers return errors in non-standard formats. Without these patterns,
 * errors get misclassified (e.g., a context overflow classified as "format"),
 * causing the failover engine to choose wrong recovery strategies.
 */

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
  // AWS Bedrock
  /ValidationException.*(?:input is too long|max input token|input token.*exceed)/i,
  /ValidationException.*(?:exceeds? the (?:maximum|max) (?:number of )?(?:input )?tokens)/i,
  /ModelStreamErrorException.*(?:Input is too long|too many input tokens)/i,

  // Azure OpenAI (sometimes wraps OpenAI errors differently)
  /content_filter.*(?:prompt|input).*(?:too long|exceed)/i,

  // Ollama / local models
  /\bollama\b.*(?:context length|too many tokens|context window)/i,
  /\btruncating input\b.*\btoo long\b/i,

  // Mistral
  /\bmistral\b.*(?:input.*too long|token limit.*exceeded)/i,

  // Cohere
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i,

  // DeepSeek
  /\bdeepseek\b.*(?:input.*too long|context.*exceed)/i,

  // Google Vertex / Gemini: INVALID_ARGUMENT with token-related messages is context overflow.
  /INVALID_ARGUMENT.*(?:exceeds? the (?:maximum|max)|input.*too (?:long|large))/i,

  // Generic "input too long" pattern that isn't covered by existing checks
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

/**
 * Provider-specific patterns that map to specific failover reasons.
 * These handle cases where the generic classifiers in failover-matches.ts
 * produce wrong results for specific providers.
 */
export const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[] = [
  // AWS Bedrock: ThrottlingException is rate limit
  {
    test: /ThrottlingException|Too many concurrent requests/i,
    reason: "rate_limit",
  },

  // AWS Bedrock: ModelNotReadyException (require class prefix to avoid false positives)
  {
    test: /ModelNotReadyException/i,
    reason: "overloaded",
  },

  // Azure: content_policy_violation should not trigger failover
  // (it's a content moderation rejection, not a transient error)

  // Groq: model_deactivated is permanent
  {
    test: /model(?:_is)?_deactivated|model has been deactivated/i,
    reason: "model_not_found",
  },

  // Together AI / Fireworks: specific rate limit messages
  {
    test: /\bconcurrency limit\b.*\breached\b/i,
    reason: "rate_limit",
  },

  // Cloudflare Workers AI
  {
    test: /\bworkers?_ai\b.*\b(?:rate|limit|quota)\b/i,
    reason: "rate_limit",
  },
];

/**
 * Check if an error message matches any provider-specific context overflow pattern.
 * Called from `isContextOverflowError()` to catch provider-specific wording.
 */
export function matchesProviderContextOverflow(errorMessage: string): boolean {
  return PROVIDER_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

/**
 * Try to classify an error using provider-specific patterns.
 * Returns null if no provider-specific pattern matches (fall through to generic classification).
 */
export function classifyProviderSpecificError(errorMessage: string): FailoverReason | null {
  for (const pattern of PROVIDER_SPECIFIC_PATTERNS) {
    if (pattern.test.test(errorMessage)) {
      return pattern.reason;
    }
  }
  return null;
}
