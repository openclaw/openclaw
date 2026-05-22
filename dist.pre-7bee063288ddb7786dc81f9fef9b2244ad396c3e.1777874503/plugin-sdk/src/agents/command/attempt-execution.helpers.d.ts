import { type ClaudeCliFallbackSeed } from "../../gateway/cli-session-history.js";
/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.
 */
export declare function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean>;
export declare function claudeCliSessionTranscriptHasContent(params: {
    sessionId: string | undefined;
    homeDir?: string;
}): Promise<boolean>;
export declare function resolveFallbackRetryPrompt(params: {
    body: string;
    isFallbackRetry: boolean;
    sessionHasHistory?: boolean;
    priorContextPrelude?: string;
}): string;
/**
 * Format a previously-harvested Claude CLI session into a labeled prelude
 * suitable for prepending to a fallback candidate's prompt. Behavior matches
 * Claude Code's own resume strategy after compaction: prefer the explicit
 * summary, then append the most recent turns up to a char budget.
 *
 * Returns an empty string when neither a summary nor any usable turn fits in
 * the budget; callers can treat that as "no context to seed".
 */
export declare function formatClaudeCliFallbackPrelude(seed: ClaudeCliFallbackSeed, options?: {
    charBudget?: number;
}): string;
/**
 * Read the Claude CLI session pointed to by `cliSessionId` and format a
 * fallback prelude. Returns `""` when no session file is found or when the
 * harvested seed has no usable content.
 */
export declare function buildClaudeCliFallbackContextPrelude(params: {
    cliSessionId: string | undefined;
    homeDir?: string;
    charBudget?: number;
}): string;
export declare function createAcpVisibleTextAccumulator(): {
    consume(chunk: string): {
        text: string;
        delta: string;
    } | null;
    finalize(): string;
    finalizeRaw(): string;
};
