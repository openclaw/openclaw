import fs from "node:fs/promises";
import path from "node:path";
import type {
  MeetingNotesSessionDescriptor,
  MeetingNotesUtterance,
} from "openclaw/plugin-sdk/meeting-notes";
import type { MeetingNotesSummary } from "./summary.js";
import { renderMeetingNotesMarkdown } from "./summary.js";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export class MeetingNotesStore {
  constructor(private readonly rootDir: string) {}

  sessionDir(sessionId: string): string {
    return path.join(this.rootDir, safeSegment(sessionId));
  }

  async writeSession(session: MeetingNotesSessionDescriptor): Promise<void> {
    const dir = this.sessionDir(session.sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "metadata.json"), `${JSON.stringify(session, null, 2)}\n`);
  }

  async readSession(sessionId: string): Promise<MeetingNotesSessionDescriptor | undefined> {
    return await readJsonFile<MeetingNotesSessionDescriptor>(
      path.join(this.sessionDir(sessionId), "metadata.json"),
    );
  }

  async appendUtterance(sessionId: string, utterance: MeetingNotesUtterance): Promise<void> {
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, "transcript.jsonl"),
      `${JSON.stringify({ ...utterance, sessionId })}\n`,
    );
  }

  async readUtterances(sessionId: string): Promise<MeetingNotesUtterance[]> {
    const transcriptPath = path.join(this.sessionDir(sessionId), "transcript.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(transcriptPath, "utf8");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MeetingNotesUtterance);
  }

  async updateStopped(sessionId: string, stoppedAt: string): Promise<void> {
    const session = await this.readSession(sessionId);
    if (!session) {
      return;
    }
    await this.writeSession({ ...session, stoppedAt });
  }

  async writeSummary(summary: MeetingNotesSummary): Promise<string> {
    const dir = this.sessionDir(summary.sessionId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const markdown = renderMeetingNotesMarkdown(summary);
    const markdownPath = path.join(dir, "summary.md");
    await fs.writeFile(markdownPath, `${markdown}\n`);
    return markdownPath;
  }
}
