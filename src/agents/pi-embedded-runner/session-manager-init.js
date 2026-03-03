import fs from "node:fs/promises";
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
export async function prepareSessionManagerForRun(params) {
    const sm = params.sessionManager;
    const header = sm.fileEntries.find((e) => e.type === "session");
    const hasAssistant = sm.fileEntries.some((e) => e.type === "message" && e.message?.role === "assistant");
    if (!params.hadSessionFile && header) {
        header.id = params.sessionId;
        header.cwd = params.cwd;
        sm.sessionId = params.sessionId;
        return;
    }
    if (params.hadSessionFile && header && !hasAssistant) {
        // Reset file so the first assistant flush includes header+user+assistant in order.
        await fs.writeFile(params.sessionFile, "", "utf-8");
        sm.fileEntries = [header];
        sm.byId?.clear?.();
        sm.labelsById?.clear?.();
        sm.leafId = null;
        sm.flushed = false;
    }
}
