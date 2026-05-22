/**
 * Compaction instruction utilities.
 *
 * Provides default language-preservation instructions and a precedence-based
 * resolver for customInstructions used during context compaction summaries.
 */
/**
 * Default instructions injected into every safeguard-mode compaction summary.
 * Preserves conversation language and persona while keeping the SDK's required
 * summary structure intact.
 */
export declare const DEFAULT_COMPACTION_INSTRUCTIONS: string;
/**
 * Resolve compaction instructions with precedence:
 *   event (SDK) → runtime (config) → DEFAULT constant.
 *
 * Each input is normalized first (trim + empty→undefined) so that blank
 * strings don't short-circuit the fallback chain.
 */
export declare function resolveCompactionInstructions(eventInstructions: string | undefined, runtimeInstructions: string | undefined): string;
/**
 * Compose split-turn instructions by combining the SDK's turn-prefix
 * instructions with the resolved compaction instructions.
 */
export declare function composeSplitTurnInstructions(turnPrefixInstructions: string, resolvedInstructions: string): string;
