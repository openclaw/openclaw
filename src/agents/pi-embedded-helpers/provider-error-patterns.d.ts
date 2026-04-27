/**
 * Provider-owned error-pattern dispatch plus legacy fallback patterns.
 *
 * Most provider-specific failover classification now lives on provider-plugin
 * hooks. This module keeps only fallback patterns for providers that do not
 * yet ship a dedicated provider plugin hook surface.
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
export declare const PROVIDER_CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[];
/**
 * Provider-specific patterns that map to specific failover reasons.
 * These handle cases where the generic classifiers in failover-matches.ts
 * produce wrong results for specific providers.
 */
export declare const PROVIDER_SPECIFIC_PATTERNS: readonly ProviderErrorPattern[];
/**
 * Check if an error message matches any provider-specific context overflow pattern.
 * Called from `isContextOverflowError()` to catch provider-specific wording.
 */
export declare function matchesProviderContextOverflow(errorMessage: string): boolean;
/**
 * Try to classify an error using provider-specific patterns.
 * Returns null if no provider-specific pattern matches (fall through to generic classification).
 */
export declare function classifyProviderSpecificError(errorMessage: string): FailoverReason | null;
export {};
