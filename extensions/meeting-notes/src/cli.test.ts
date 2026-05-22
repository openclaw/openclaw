import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMeetingNotesCli } from "./cli.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function makeStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-cli-"));
}

async function writeSession(stateDir: string, sessionId: string): Promise<string> {
  const sessionDir = path.join(stateDir, "meeting-notes", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "metadata.json"),
    `${JSON.stringify(
      {
        sessionId,
        title: "Design review",
        source: { providerId: "manual-transcript" },
        startedAt: "2026-05-22T10:00:00.000Z",
        stoppedAt: "2026-05-22T10:05:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(sessionDir, "summary.md"),
    "# Design review\n\n## Action Items\n- Sam: Ship CLI\n",
  );
  return sessionDir;
}

async function runMeetingNotesCli(args: string[]): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    const program = new Command();
    program.name("openclaw");
    registerMeetingNotesCli(program);
    await program.parseAsync(["meeting-notes", ...args], { from: "user" });
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

describe("meeting-notes CLI", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await makeStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("registers a kebab-case command", () => {
    const program = new Command();
    registerMeetingNotesCli(program);

    expect(program.commands.map((command) => command.name())).toContain("meeting-notes");
  });

  it("lists stored meeting note sessions", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");

    const output = await runMeetingNotesCli(["list"]);

    expect(output).toContain("design-review");
    expect(output).toContain("Design review");
    expect(output).toContain(path.join(sessionDir, "summary.md"));
  });

  it("prints summary markdown for a session", async () => {
    await writeSession(stateDir, "design-review");

    const output = await runMeetingNotesCli(["show", "design-review"]);

    expect(output).toContain("# Design review");
    expect(output).toContain("Ship CLI");
  });

  it("ignores unrelated corrupt metadata while reading a valid session", async () => {
    await writeSession(stateDir, "design-review");
    const corruptDir = path.join(stateDir, "meeting-notes", "corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "metadata.json"), "{nope");

    const listOutput = await runMeetingNotesCli(["list"]);
    const showOutput = await runMeetingNotesCli(["show", "design-review"]);

    expect(listOutput).toContain("design-review");
    expect(listOutput).not.toContain("corrupt");
    expect(showOutput).toContain("# Design review");
  });

  it("prints the summary path by default", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");

    const output = await runMeetingNotesCli(["path", "design-review"]);

    expect(output.trim()).toBe(path.join(sessionDir, "summary.md"));
  });
});
