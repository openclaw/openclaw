import fs from "node:fs/promises";

type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };
type SessionMessageEntry = {
  type: "message";
  message?: { role?: string; content?: unknown };
};

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
export async function prepareSessionManagerForRun(params: {
  sessionManager: unknown;
  sessionFile: string;
  hadSessionFile: boolean;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  const sm = params.sessionManager as {
    sessionId: string;
    flushed: boolean;
    fileEntries: Array<SessionHeaderEntry | SessionMessageEntry | { type: string }>;
    byId?: Map<string, unknown>;
    labelsById?: Map<string, unknown>;
    leafId?: string | null;
  };

  const header = sm.fileEntries.find((e): e is SessionHeaderEntry => e.type === "session");
  const hasAssistant = sm.fileEntries.some(
    (e) => e.type === "message" && (e as SessionMessageEntry).message?.role === "assistant",
  );

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
    return;
  }

  if (params.hadSessionFile) {
    // Strip trailing empty assistant messages left by aborted runs.
    // An abort mid-stream can write an assistant entry with content:[] before any
    // tokens arrive, causing the next "continue" to loop on the same tool calls.
    const lastEntry = sm.fileEntries[sm.fileEntries.length - 1];
    const lastMsg = (lastEntry as SessionMessageEntry | undefined)?.message;
    const isEmptyAssistant =
      lastEntry?.type === "message" &&
      lastMsg?.role === "assistant" &&
      Array.isArray(lastMsg.content) &&
      (lastMsg.content as unknown[]).length === 0;

    if (isEmptyAssistant) {
      sm.fileEntries.pop();
      // Rewrite file without the trailing empty assistant entry.
      const repaired = sm.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.writeFile(params.sessionFile, repaired, "utf-8");
    }
  }
}
