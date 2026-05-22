import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
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

function normalizeMaxUtterances(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
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

  async readUtterances(
    sessionId: string,
    options: { maxUtterances?: number } = {},
  ): Promise<MeetingNotesUtterance[]> {
    const transcriptPath = path.join(this.sessionDir(sessionId), "transcript.jsonl");
    const maxUtterances = normalizeMaxUtterances(options.maxUtterances);
    if (maxUtterances !== undefined) {
      const utterances: MeetingNotesUtterance[] = [];
      try {
        const lines = createInterface({
          input: createReadStream(transcriptPath, { encoding: "utf8" }),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          if (!line) {
            continue;
          }
          utterances.push(JSON.parse(line) as MeetingNotesUtterance);
          if (utterances.length > maxUtterances) {
            utterances.shift();
          }
        }
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          return [];
        }
        throw err;
      }
      return utterances;
    }
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
