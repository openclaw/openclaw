import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "./attempt-execution.js";

const tempDirs: string[] = [];

async function createSessionFile(
  messages: Array<{ role: string; content: string; timestamp: number }>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-execution-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 7,
      id: "session-1",
      timestamp: new Date().toISOString(),
      cwd: dir,
    }),
  ];
  let parentId: string | null = null;
  for (const [index, message] of messages.entries()) {
    const id = `msg-${index + 1}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date(message.timestamp).toISOString(),
        message: {
          role: message.role,
          content: message.content,
        },
      }),
    );
    parentId = id;
  }
  await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf-8");
  return sessionFile;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveFallbackRetryPrompt", () => {
  it("keeps the original prompt when this run has not persisted it yet", async () => {
    const sessionFile = await createSessionFile([
      { role: "user", content: "older prompt", timestamp: 1_000 },
      { role: "assistant", content: "done", timestamp: 1_100 },
    ]);

    expect(
      resolveFallbackRetryPrompt({
        body: "new task",
        isFallbackRetry: true,
        runStartedAt: 2_000,
        sessionFile,
      }),
    ).toBe("new task");
  });

  it("uses the resume prompt when the current run already wrote the same user turn", async () => {
    const sessionFile = await createSessionFile([
      { role: "user", content: "new task", timestamp: 2_100 },
    ]);

    expect(
      resolveFallbackRetryPrompt({
        body: "new task",
        isFallbackRetry: true,
        runStartedAt: 2_000,
        sessionFile,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");
  });

  it("keeps the original prompt when the transcript file does not exist", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "new task",
        isFallbackRetry: true,
        runStartedAt: 2_000,
        sessionFile: path.join(os.tmpdir(), "openclaw-missing-session.jsonl"),
      }),
    ).toBe("new task");
  });
});
