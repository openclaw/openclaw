import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCompletionFromCurrentRunTranscript } from "./subagent-session-reconciliation.js";

describe("subagent session reconciliation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-reconcile-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(events: unknown[]): Promise<string> {
    const transcriptFile = path.join(tmpDir, "child-run.jsonl");
    await fs.writeFile(
      transcriptFile,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf-8",
    );
    return transcriptFile;
  }

  it("recovers completion from the current run private terminal stop turn", async () => {
    const startedAt = Date.parse("2026-03-24T12:00:00Z");
    const endedAt = startedAt + 1_234;
    const transcriptFile = await writeTranscript([
      { type: "session", version: 1, id: "sess-child" },
      {
        message: {
          role: "assistant",
          content: "stale copied answer",
          stopReason: "stop",
          timestamp: startedAt - 1,
        },
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "current child result" }],
          stopReason: "stop",
          timestamp: endedAt,
        },
      },
    ]);

    await expect(
      resolveCompletionFromCurrentRunTranscript({
        childSessionKey: "agent:main:subagent:child",
        transcriptFile,
        fallbackEndedAt: endedAt + 10_000,
        notBeforeMs: startedAt,
        startedAt,
      }),
    ).resolves.toEqual({
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: "subagent-complete",
      resultText: "current child result",
    });
  });

  it("does not recover stale copied output from before the current run", async () => {
    const startedAt = Date.parse("2026-03-24T12:00:00Z");
    const transcriptFile = await writeTranscript([
      { type: "session", version: 1, id: "sess-child" },
      {
        message: {
          role: "assistant",
          content: "old child result",
          stopReason: "stop",
          timestamp: startedAt - 1,
        },
      },
    ]);

    await expect(
      resolveCompletionFromCurrentRunTranscript({
        childSessionKey: "agent:main:subagent:child",
        transcriptFile,
        fallbackEndedAt: startedAt + 1_000,
        notBeforeMs: startedAt,
        startedAt,
      }),
    ).resolves.toBeNull();
  });

  it.each(["error", "aborted", "toolUse"])(
    "does not recover a non-success terminal turn with stopReason=%s",
    async (stopReason) => {
      const startedAt = Date.parse("2026-03-24T12:00:00Z");
      const transcriptFile = await writeTranscript([
        { type: "session", version: 1, id: "sess-child" },
        {
          message: {
            role: "assistant",
            content: "partial child text",
            stopReason,
            timestamp: startedAt + 1,
          },
        },
      ]);

      await expect(
        resolveCompletionFromCurrentRunTranscript({
          childSessionKey: "agent:main:subagent:child",
          transcriptFile,
          fallbackEndedAt: startedAt + 10_000,
          notBeforeMs: startedAt,
          startedAt,
        }),
      ).resolves.toBeNull();
    },
  );
});
