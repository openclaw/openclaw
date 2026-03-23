import fs from "node:fs/promises";

type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };
type SessionMessageEntry = { type: "message"; id?: string; message?: { role?: string; stopReason?: string } };

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
  }

  // On fallback retry, the session JSONL already contains user+assistant(error) pairs
  // from previous failed attempts. Strip trailing orphaned user messages so prompt()
  // doesn't write yet another duplicate. (Fixes #31101, #46005)
  if (params.hadSessionFile && header && hasAssistant) {
    stripTrailingOrphanedUserMessages(sm);
  }
}

/**
 * Remove user messages that appear after the last assistant entry.
 * These are orphans from a failed embedded run (rate limit, model exhaustion)
 * that would cause prompt() to persist a duplicate on retry.
 */
function stripTrailingOrphanedUserMessages(sm: {
  fileEntries: Array<SessionHeaderEntry | SessionMessageEntry | { type: string }>;
  byId?: Map<string, unknown>;
  leafId?: string | null;
}): void {
  let lastAssistantIdx = -1;
  for (let i = sm.fileEntries.length - 1; i >= 0; i--) {
    const e = sm.fileEntries[i];
    if (e.type === "message" && (e as SessionMessageEntry).message?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return;

  const indicesToRemove: number[] = [];
  for (let i = lastAssistantIdx + 1; i < sm.fileEntries.length; i++) {
    const e = sm.fileEntries[i];
    if (e.type === "message" && (e as SessionMessageEntry).message?.role === "user") {
      indicesToRemove.push(i);
    }
  }
  if (indicesToRemove.length === 0) return;

  for (const idx of indicesToRemove.reverse()) {
    const removed = sm.fileEntries.splice(idx, 1)[0] as SessionMessageEntry | undefined;
    if (removed?.id) {
      sm.byId?.delete(removed.id);
    }
  }

  const lastEntry = sm.fileEntries[sm.fileEntries.length - 1];
  sm.leafId = lastEntry && "id" in lastEntry ? (lastEntry as SessionMessageEntry).id ?? null : null;
}
