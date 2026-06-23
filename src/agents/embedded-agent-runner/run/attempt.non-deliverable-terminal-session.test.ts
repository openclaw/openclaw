import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveNonDeliverableTerminalSessionIfNeeded,
} from "./attempt.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-non-deliverable-"));
  tempDirs.push(dir);
  return dir;
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("archiveNonDeliverableTerminalSessionIfNeeded", () => {
  it("archives a transcript whose latest session end was non-deliverable", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const trajectoryFile = path.join(dir, "session.trajectory.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
    await fs.writeFile(
      trajectoryFile,
      [
        JSON.stringify({ type: "model.completed" }),
        "not json",
        JSON.stringify({
          type: "session.ended",
          data: {
            status: "error",
            terminalError: "non_deliverable_terminal_turn",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const warnings: string[] = [];
    await expect(
      archiveNonDeliverableTerminalSessionIfNeeded({
        sessionFile,
        sessionId: "session",
        sessionKey: "agent:main:test",
        env: {},
        warn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(true);

    expect(await exists(sessionFile)).toBe(false);
    expect(await exists(trajectoryFile)).toBe(false);
    expect(await fs.readdir(dir)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^session\.jsonl\.non-deliverable-\d+\.bak$/),
        expect.stringMatching(/^session\.trajectory\.jsonl\.non-deliverable-\d+\.bak$/),
      ]),
    );
    expect(warnings.join("\n")).toContain("agent:main:test");
  });

  it("does not archive when a later session end succeeded", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const trajectoryFile = path.join(dir, "session.trajectory.jsonl");
    await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");
    await fs.writeFile(
      trajectoryFile,
      [
        JSON.stringify({
          type: "session.ended",
          data: {
            status: "error",
            terminalError: "non_deliverable_terminal_turn",
          },
        }),
        JSON.stringify({
          type: "session.ended",
          data: {
            status: "success",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await expect(
      archiveNonDeliverableTerminalSessionIfNeeded({
        sessionFile,
        sessionId: "session",
        env: {},
        warn: () => undefined,
      }),
    ).resolves.toBe(false);

    expect(await exists(sessionFile)).toBe(true);
    expect(await exists(trajectoryFile)).toBe(true);
  });
});
