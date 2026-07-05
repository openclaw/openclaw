/**
 * Prepares session managers and transcript state before embedded runs.
 */
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serializeJsonlLine, writeJsonlLines } from "../../config/sessions/transcript-jsonl.js";
import { invalidateSessionFileRepairCache } from "../session-file-repair.js";

type SessionHeaderEntry = {
  type: "session";
  id?: string;
  cwd?: string;
  parentSession?: string;
};
type SessionMessageEntry = { type: "message"; message?: { role?: string } };

async function assertExistingHeaderIsReadable(sessionFile: string): Promise<void> {
  const content = await fs.readFile(sessionFile, "utf-8");
  const firstLine = content.split("\n").find((line) => line.trim());
  if (!firstLine) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    throw new Error(`Refusing to reset session transcript with unreadable header: ${sessionFile}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || parsed.type !== "session") {
    throw new Error(`Refusing to reset session transcript with invalid header: ${sessionFile}`);
  }
}

/**
 * session runtime SessionManager persistence quirk:
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
    cwd: string;
    flushed: boolean;
    fileEntries: Array<SessionHeaderEntry | SessionMessageEntry | { type: string }>;
    byId?: Map<string, unknown>;
    labelsById?: Map<string, unknown>;
    leafId?: string | null;
    wasRecoveredFromCorruptHeader?: () => boolean;
    clearPreservedOpaqueFileEntries?: () => void;
    getSerializedFileLinesForRewrite?: () => string[];
    syncSnapshotAfterHeaderRewrite?: (expectedContent?: string) => void;
  };

  const header = sm.fileEntries.find((e): e is SessionHeaderEntry => e.type === "session");
  const hasAssistant = sm.fileEntries.some(
    (e) => e.type === "message" && (e as SessionMessageEntry).message?.role === "assistant",
  );

  if (!params.hadSessionFile && header) {
    header.id = params.sessionId;
    header.cwd = params.cwd;
    sm.sessionId = params.sessionId;
    sm.cwd = params.cwd;
    return;
  }

  if (params.hadSessionFile && header && !hasAssistant) {
    const preservesForkedBranch =
      typeof header.parentSession === "string" && header.parentSession.length > 0;
    if (sm.wasRecoveredFromCorruptHeader?.() || preservesForkedBranch) {
      // Fork transcripts can intentionally select a user-only or empty branch.
      // Keep their copied tree so the first run appends at the preserved cursor.
      header.id = params.sessionId;
      header.cwd = params.cwd;
      sm.sessionId = params.sessionId;
      sm.cwd = params.cwd;
      const content = await writeJsonlLines(
        params.sessionFile,
        sm.getSerializedFileLinesForRewrite?.() ?? sm.fileEntries.map(serializeJsonlLine),
        {
          mode: 0o600,
        },
      );
      sm.flushed = true;
      sm.syncSnapshotAfterHeaderRewrite?.(content);
      return;
    }

    // Reset file so the first assistant flush includes header+user+assistant in order.
    await assertExistingHeaderIsReadable(params.sessionFile);
    await fs.writeFile(params.sessionFile, "", "utf-8");
    invalidateSessionFileRepairCache(params.sessionFile);
    header.id = params.sessionId;
    header.cwd = params.cwd;
    sm.sessionId = params.sessionId;
    sm.cwd = params.cwd;
    sm.fileEntries = [header];
    sm.clearPreservedOpaqueFileEntries?.();
    sm.byId?.clear?.();
    sm.labelsById?.clear?.();
    sm.leafId = null;
    sm.flushed = false;
    return;
  }

  if (params.hadSessionFile && header) {
    const headerChanged = header.id !== params.sessionId || header.cwd !== params.cwd;
    header.id = params.sessionId;
    header.cwd = params.cwd;
    sm.sessionId = params.sessionId;
    sm.cwd = params.cwd;
    if (!headerChanged) {
      sm.flushed = true;
      return;
    }
    const content = await writeJsonlLines(
      params.sessionFile,
      sm.getSerializedFileLinesForRewrite?.() ?? sm.fileEntries.map(serializeJsonlLine),
      {
        mode: 0o600,
      },
    );
    sm.flushed = true;
    sm.syncSnapshotAfterHeaderRewrite?.(content);
  }
}
