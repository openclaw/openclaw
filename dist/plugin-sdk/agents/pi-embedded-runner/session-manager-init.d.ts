/**
 * pi-coding-agent SessionManager persistence quirk:
 * - If the file exists but has no assistant message, SessionManager marks itself `flushed=true`
 *   and will never persist the initial user message.
 * - If the file doesn't exist yet, SessionManager builds a new session in memory and flushes
 *   header+user+assistant once the first assistant arrives (good).
 *
 * This normalizes the file/session state so the first user prompt is persisted before the first
 * assistant entry, even for pre-created session files.
 */
export declare function prepareSessionManagerForRun(params: {
    sessionManager: unknown;
    sessionFile: string;
    hadSessionFile: boolean;
    sessionId: string;
    cwd: string;
}): Promise<void>;
