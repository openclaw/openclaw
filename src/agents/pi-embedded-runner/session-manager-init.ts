import fs from "node:fs/promises";

type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };
type SessionMessageEntry = { type: "message"; message?: { role?: string }; id?: string };

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

  // On retry attempts, the JSONL file already contains the user message from
  // the previous attempt. When SessionManager is reconstructed from the file
  // with hasAssistant=true, flushed=true, so prompt() will immediately
  // appendFileSync a duplicate user message. Strip trailing orphaned user
  // messages (user messages after the last assistant) to prevent duplicates.
  if (params.hadSessionFile && header && hasAssistant) {
    await stripTrailingOrphanedUserMessages(sm, params.sessionFile);
  }
}

async function stripTrailingOrphanedUserMessages(
  sm: {
    flushed: boolean;
    fileEntries: Array<SessionHeaderEntry | SessionMessageEntry | { type: string }>;
    byId?: Map<string, unknown>;
    labelsById?: Map<string, unknown>;
    leafId?: string | null;
  },
  sessionFile: string,
): Promise<void> {
  // Find the last assistant message index
  let lastAssistantIdx = -1;
  for (let i = sm.fileEntries.length - 1; i >= 0; i--) {
    const e = sm.fileEntries[i];
    if (e.type === "message" && (e as SessionMessageEntry).message?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return;

  // Check if there are user messages after the last assistant
  const trailingUserIndices: number[] = [];
  for (let i = lastAssistantIdx + 1; i < sm.fileEntries.length; i++) {
    const e = sm.fileEntries[i];
    if (e.type === "message" && (e as SessionMessageEntry).message?.role === "user") {
      trailingUserIndices.push(i);
    }
  }
  if (trailingUserIndices.length === 0) return;

  // Remove trailing user messages from in-memory entries
  for (const idx of trailingUserIndices.reverse()) {
    const removed = sm.fileEntries.splice(idx, 1)[0];
    if (removed && "id" in removed && typeof (removed as SessionMessageEntry).id === "string") {
      sm.byId?.delete((removed as SessionMessageEntry).id!);
      sm.labelsById?.delete((removed as SessionMessageEntry).id!);
    }
  }

  // Update leafId to the last remaining entry
  const lastEntry = sm.fileEntries[sm.fileEntries.length - 1];
  sm.leafId = lastEntry && "id" in lastEntry ? (lastEntry as SessionMessageEntry).id ?? null : null;

  // Rewrite the file without the orphaned user messages
  const lines = sm.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(sessionFile, lines, "utf-8");
}
