import fs from "node:fs";
import fsPromises from "node:fs/promises";
import readline from "node:readline";

type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };
type SessionMessageEntry = { type: "message"; message?: { role?: string } };
type SessionTranscriptEntry = { type?: string; message?: { role?: string } };
const MAX_TRANSCRIPT_SCAN_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_SCAN_LINES = 2_000;

function isAssistantMessageEntry(entry: SessionTranscriptEntry): entry is SessionMessageEntry {
  return entry.type === "message" && entry.message?.role === "assistant";
}

async function statRegularSessionTranscript(
  sessionFile: string,
): Promise<Awaited<ReturnType<typeof fsPromises.lstat>>> {
  const stat = await fsPromises.lstat(sessionFile);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Session transcript must be a regular file: ${sessionFile}`);
  }
  return stat;
}

export async function shouldInjectBootstrapContext(sessionFile: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fsPromises.lstat>>;
  try {
    stat = await statRegularSessionTranscript(sessionFile);
  } catch {
    return true;
  }
  if (stat.size <= 0) {
    return true;
  }

  const byteLimit = Math.min(stat.size, MAX_TRANSCRIPT_SCAN_BYTES);
  let stream: fs.ReadStream | null = null;
  let rl: readline.Interface | null = null;

  let scannedLines = 0;
  let scannedBytes = 0;
  try {
    stream = fs.createReadStream(sessionFile, {
      encoding: "utf-8",
      end: Math.max(0, byteLimit - 1),
    });
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      scannedLines += 1;
      scannedBytes += Buffer.byteLength(rawLine, "utf8");
      if (scannedLines > MAX_TRANSCRIPT_SCAN_LINES || scannedBytes > MAX_TRANSCRIPT_SCAN_BYTES) {
        return true;
      }

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
  } catch {
    return true;
  } finally {
    rl?.close();
    stream?.destroy();
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
    await statRegularSessionTranscript(params.sessionFile);
    // Reset file so the first assistant flush includes header+user+assistant in order.
    await fsPromises.writeFile(params.sessionFile, "", "utf-8");
    sm.fileEntries = [header];
    sm.byId?.clear?.();
    sm.labelsById?.clear?.();
    sm.leafId = null;
    sm.flushed = false;
  }
}
