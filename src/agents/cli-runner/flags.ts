/**
 * Shared feature flags for the Claude CLI runner.
 *
 * Kept in a standalone module so both `helpers.ts` (system prompt assembly)
 * and `execute.ts` (loader + verification state machine) can consult the same
 * toggle without a circular import.
 */

/**
 * When true, the CLI runner uses the semantic prompt loader: workspace
 * context files are referenced by their real on-disk paths, and a single
 * per-session file holds the programmatically assembled content. Verification
 * is Set-based and tolerates parallel out-of-order Read completions.
 *
 * When false, the legacy byte-chunked loader is used.
 */
export const ENABLE_SEMANTIC_PROMPT_LOADER = true;
