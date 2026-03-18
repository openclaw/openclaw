import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readTranscriptFile } from "../src/transcript.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ov-bridge-test-"));
}

function writeLines(filePath: string, lines: unknown[]): void {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
}

describe("readTranscriptFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent file", async () => {
    const result = await readTranscriptFile(path.join(tmpDir, "missing.jsonl"));
    expect(result).toEqual([]);
  });

  it("parses user and assistant messages", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      { type: "session", version: 3, id: "test-id", timestamp: "2026-01-01T00:00:00Z" },
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "World" } },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 0, role: "user", text: "Hello" });
    expect(turns[1]).toMatchObject({ index: 1, role: "assistant", text: "World" });
  });

  it("skips non-message entries", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      { type: "model_change", modelId: "claude-3" },
      { type: "message", message: { role: "user", content: "Hi" } },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("user");
  });

  it("skips NO_REPLY responses", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      { type: "message", message: { role: "user", content: "silent command" } },
      { type: "message", message: { role: "assistant", content: "NO_REPLY" } },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("user");
  });

  it("skips system messages", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      { type: "message", message: { role: "system", content: "You are..." } },
      { type: "message", message: { role: "user", content: "Hi" } },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(1);
  });

  it("extracts text from content parts array", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Part one" },
            { type: "tool_use", id: "tu1", name: "search", input: {} },
            { type: "text", text: "Part two" },
          ],
        },
      },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe("Part one\nPart two");
  });

  it("skips entries with only tool parts (no text)", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "bash", input: {} }],
        },
      },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(0);
  });

  it("skips malformed JSON lines", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "Hello" } }),
        "{bad json here",
        JSON.stringify({ type: "message", message: { role: "assistant", content: "Hi" } }),
      ].join("\n"),
    );

    const turns = await readTranscriptFile(filePath);
    expect(turns).toHaveLength(2);
  });

  it("assigns sequential indexes", async () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    writeLines(filePath, [
      { type: "message", message: { role: "user", content: "A" } },
      { type: "message", message: { role: "user", content: "NO_REPLY" } }, // skipped
      { type: "message", message: { role: "assistant", content: "B" } },
      { type: "message", message: { role: "user", content: "C" } },
    ]);

    const turns = await readTranscriptFile(filePath);
    expect(turns.map((t) => t.index)).toEqual([0, 1, 2]);
  });
});
