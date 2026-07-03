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

const SESSION_HEADER_READ_CHUNK_BYTES = 4096;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;

type SessionFileHeaderRead = {
  firstLine?: string;
  cappedBeforeFirstLine: boolean;
};

async function readFirstSessionFileLine(sessionFile: string): Promise<SessionFileHeaderRead> {
  const handle = await fs.open(sessionFile, "r");
  try {
    const chunks: string[] = [];
    let totalBytes = 0;
    while (totalBytes < MAX_SESSION_HEADER_BYTES) {
      const buffer = Buffer.alloc(
        Math.min(SESSION_HEADER_READ_CHUNK_BYTES, MAX_SESSION_HEADER_BYTES - totalBytes),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.toString("utf-8", 0, bytesRead));
      const nextTotalBytes = totalBytes + bytesRead;
      const readEnd = bytesRead < buffer.length || nextTotalBytes >= MAX_SESSION_HEADER_BYTES;
      const scannedText = chunks.join("");
      const lines = scannedText.split(/\r?\n/u);
      const hasCompleteLine = lines.length > 1;
      const linesToScan = hasCompleteLine ? lines.slice(0, -1) : readEnd ? lines : [];
      for (const line of linesToScan) {
        const trimmed = line.trim();
        if (trimmed) {
          return { firstLine: trimmed, cappedBeforeFirstLine: false };
        }
      }
      totalBytes = nextTotalBytes;
      if (totalBytes >= MAX_SESSION_HEADER_BYTES) {
        return { cappedBeforeFirstLine: true };
      }
    }
    const firstLine = chunks
      .join("")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return { firstLine, cappedBeforeFirstLine: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertExistingHeaderIsReadable(sessionFile: string): Promise<void> {
  const { firstLine, cappedBeforeFirstLine } = await readFirstSessionFileLine(sessionFile);
  if (cappedBeforeFirstLine) {
    throw new Error(
      `Refusing to reset session transcript before finding a readable header: ${sessionFile}`,
    );
  }
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
