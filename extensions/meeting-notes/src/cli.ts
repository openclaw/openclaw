import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { MeetingNotesSessionDescriptor } from "openclaw/plugin-sdk/meeting-notes";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type MeetingNotesCliOptions = {
  json?: boolean;
};

type MeetingNotesPathOptions = MeetingNotesCliOptions & {
  dir?: boolean;
  metadata?: boolean;
  transcript?: boolean;
};

type StoredMeetingNotesSession = {
  session: MeetingNotesSessionDescriptor;
  sessionDir: string;
  summaryPath: string;
  hasSummary: boolean;
};

const MEETING_NOTES_STATE_SUBDIR = "meeting-notes";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function stateRootDir(): string {
  return path.join(resolveStateDir(), MEETING_NOTES_STATE_SUBDIR);
}

function sessionDir(sessionId: string): string {
  return path.join(stateRootDir(), safeSegment(sessionId));
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function writeJson(value: unknown): void {
  writeLine(JSON.stringify(value, null, 2));
}

function isNodeError(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === code);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return false;
    }
    throw err;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readStoredSession(
  sessionDir: string,
  options: { ignoreInvalid?: boolean } = {},
): Promise<StoredMeetingNotesSession | null> {
  const metadataPath = path.join(sessionDir, "metadata.json");
  try {
    const session = await readJsonFile<MeetingNotesSessionDescriptor>(metadataPath);
    const summaryPath = path.join(sessionDir, "summary.md");
    return {
      session,
      sessionDir,
      summaryPath,
      hasSummary: await pathExists(summaryPath),
    };
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return null;
    }
    if (options.ignoreInvalid) {
      return null;
    }
    throw new Error(
      `invalid meeting notes metadata at ${metadataPath}: ${formatErrorMessage(err)}`,
      {
        cause: err,
      },
    );
  }
}

function assertRequestedSession(
  entry: StoredMeetingNotesSession,
  sessionId: string,
): StoredMeetingNotesSession {
  if (entry.session.sessionId !== sessionId) {
    throw new Error(
      `meeting notes metadata mismatch for ${sessionId}: found ${entry.session.sessionId}`,
    );
  }
  return entry;
}

async function requireStoredSession(sessionId: string): Promise<StoredMeetingNotesSession> {
  const session = await readStoredSession(sessionDir(sessionId));
  if (!session) {
    throw new Error(`meeting notes session not found: ${sessionId}`);
  }
  return assertRequestedSession(session, sessionId);
}

async function listStoredSessions(): Promise<StoredMeetingNotesSession[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(stateRootDir(), { withFileTypes: true });
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return [];
    }
    throw err;
  }
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readStoredSession(path.join(stateRootDir(), entry.name), {
          ignoreInvalid: true,
        }),
      ),
  );
  return sessions
    .filter((session): session is StoredMeetingNotesSession => session !== null)
    .toSorted((left, right) =>
      (right.session.startedAt ?? "").localeCompare(left.session.startedAt ?? ""),
    );
}

function formatSessionLine(entry: StoredMeetingNotesSession): string {
  const title = entry.session.title?.trim() || "Meeting notes";
  const started = entry.session.startedAt || "unknown";
  const summary = entry.hasSummary ? entry.summaryPath : "no summary.md";
  return `${entry.session.sessionId}\t${started}\t${title}\t${summary}`;
}

async function listCommand(options: MeetingNotesCliOptions): Promise<void> {
  const sessions = await listStoredSessions();
  if (options.json) {
    writeJson(
      sessions.map((entry) => ({
        sessionId: entry.session.sessionId,
        title: entry.session.title,
        startedAt: entry.session.startedAt,
        stoppedAt: entry.session.stoppedAt,
        source: entry.session.source,
        path: entry.sessionDir,
        summaryPath: entry.summaryPath,
        hasSummary: entry.hasSummary,
      })),
    );
    return;
  }
  if (sessions.length === 0) {
    writeLine("No meeting notes found.");
    return;
  }
  for (const session of sessions) {
    writeLine(formatSessionLine(session));
  }
}

async function showCommand(sessionId: string, options: MeetingNotesCliOptions): Promise<void> {
  const session = await requireStoredSession(sessionId);
  if (options.json) {
    const summary = session.hasSummary ? await fs.readFile(session.summaryPath, "utf8") : null;
    writeJson({
      session: session.session,
      path: session.sessionDir,
      summaryPath: session.summaryPath,
      summary,
    });
    return;
  }
  if (!session.hasSummary) {
    throw new Error(`summary.md not found for meeting notes session: ${sessionId}`);
  }
  process.stdout.write(await fs.readFile(session.summaryPath, "utf8"));
}

async function pathCommand(sessionId: string, options: MeetingNotesPathOptions): Promise<void> {
  const session = await requireStoredSession(sessionId);
  const selectedPath = options.dir
    ? session.sessionDir
    : options.metadata
      ? path.join(session.sessionDir, "metadata.json")
      : options.transcript
        ? path.join(session.sessionDir, "transcript.jsonl")
        : session.summaryPath;
  if (options.json) {
    writeJson({ sessionId, path: selectedPath, exists: await pathExists(selectedPath) });
    return;
  }
  writeLine(selectedPath);
}

export function registerMeetingNotesCli(program: Command): void {
  const meetingNotes = program.command("meeting-notes").description("Inspect stored meeting notes");

  meetingNotes
    .command("list")
    .description("List stored meeting note sessions")
    .option("--json", "Print JSON")
    .action(async (options: MeetingNotesCliOptions) => {
      await listCommand(options);
    });

  meetingNotes
    .command("show")
    .description("Print a meeting summary markdown file")
    .argument("<session>", "Meeting notes session id")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: MeetingNotesCliOptions) => {
      await showCommand(sessionId, options);
    });

  meetingNotes
    .command("path")
    .description("Print a stored meeting notes artifact path")
    .argument("<session>", "Meeting notes session id")
    .option("--dir", "Print the session directory")
    .option("--metadata", "Print metadata.json")
    .option("--transcript", "Print transcript.jsonl")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: MeetingNotesPathOptions) => {
      await pathCommand(sessionId, options);
    });
}
