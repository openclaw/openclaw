import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type FileEntry } from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempSessionFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-manager-"));
  tempPaths.push(dir);
  return path.join(dir, "session.jsonl");
}

async function readEntries(sessionFile: string): Promise<FileEntry[]> {
  const content = await fs.readFile(sessionFile, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FileEntry);
}

describe("SessionManager persistence", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("does not duplicate a resumed user-only transcript on first assistant flush", async () => {
    const sessionFile = await makeTempSessionFile();
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          id: "resume-session",
          timestamp: "2026-06-01T00:00:00.000Z",
          cwd: "/tmp/openclaw",
        }),
        JSON.stringify({
          type: "message",
          id: "pending-user",
          parentId: null,
          timestamp: "2026-06-01T00:00:01.000Z",
          message: { role: "user", content: "pending question" },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const manager = SessionManager.open(sessionFile, path.dirname(sessionFile), "/tmp/openclaw");
    manager.appendMessage({ role: "assistant", content: "answer" });

    const entries = await readEntries(sessionFile);
    expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
    expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
    expect(
      entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "pending question",
      ),
    ).toHaveLength(1);
  });
});
