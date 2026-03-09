import fs from "node:fs/promises";

type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };
type SessionMessageEntry = { type: "message"; message?: { role?: string } };
type SessionTranscriptEntry = { type?: string; message?: { role?: string } };

function isAssistantMessageEntry(entry: SessionTranscriptEntry): entry is SessionMessageEntry {
  return entry.type === "message" && entry.message?.role === "assistant";
}

export async function shouldInjectBootstrapContext(sessionFile: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch {
    return true;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as SessionTranscriptEntry;
      if (isAssistantMessageEntry(entry)) {
        return false;
      }
    } catch {
      // Treat any read/parse uncertainty as "inject bootstrap" because missing bootstrap
      // context is more harmful than redundantly re-injecting it on a retry.
      // Fall back to injecting bootstrap context if the transcript cannot be parsed cleanly.
      return true;
    }
  }

  return true;
}

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
  const hasAssistant = sm.fileEntries.some(isAssistantMessageEntry);

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
