export type SessionKeyParams = {
    sessionKey?: string | null;
    sessionId?: string | null;
};
export type SessionKeyLogger = {
    warn: (msg: string) => void;
};
/**
 * Returns the trimmed `sessionKey` if non-empty, else logs a structured
 * warning and returns `null`. Callers decide their fallback behavior
 * explicitly (typically: early-return / skip the side-effect).
 *
 * The warning is anchored on `[session-key:missing]` so all skip sites can be
 * grepped from one place.
 *
 * @param params object containing `sessionKey` (optional) and `sessionId` (optional, used for diagnostics)
 * @param log    structured logger with `.warn`
 * @param site   stable site identifier (e.g. `"pi-runner.timeout-compaction"`) used for grouping skip events
 */
export declare function requireSessionKeyOrSkip(params: SessionKeyParams, log: SessionKeyLogger, site: string): string | null;
