import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractFinalResult, findLatestSession, parseNewEntries } from "./session-parser.js";

describe("session-parser", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-relay-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("findLatestSession", () => {
    it("returns null when no .claude directory exists", () => {
      expect(findLatestSession(tmpDir)).toBeNull();
    });

    it("returns the most recent JSONL file", () => {
      const projectDir = path.join(tmpDir, ".claude", "projects", "abc123");
      fs.mkdirSync(projectDir, { recursive: true });

      const older = path.join(projectDir, "aaa111.jsonl");
      const newer = path.join(projectDir, "bbb222.jsonl");
      fs.writeFileSync(older, '{"type":"user"}\n');

      // Ensure different mtime
      const pastTime = Date.now() - 10000;
      fs.utimesSync(older, new Date(pastTime), new Date(pastTime));

      fs.writeFileSync(newer, '{"type":"assistant"}\n');

      expect(findLatestSession(tmpDir)).toBe(newer);
    });

    it("ignores non-hex-named files", () => {
      const projectDir = path.join(tmpDir, ".claude", "projects", "abc123");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "readme.txt"), "not a session");
      fs.writeFileSync(path.join(projectDir, "sessions.json"), "{}");

      expect(findLatestSession(tmpDir)).toBeNull();
    });
  });

  describe("parseNewEntries", () => {
    it("returns empty for non-existent file", () => {
      const result = parseNewEntries("/nonexistent", 0);
      expect(result.entries).toHaveLength(0);
    });

    it("extracts assistant text entries", () => {
      const file = path.join(tmpDir, "session.jsonl");
      const lines = [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Working on it..." }] },
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "text", text: "Thanks" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Done!" },
              { type: "tool_use", name: "Write", input: { file_path: "/tmp/out.txt" } },
            ],
          },
        }),
      ];
      fs.writeFileSync(file, lines.join("\n") + "\n");

      const result = parseNewEntries(file, 0);
      expect(result.entries).toHaveLength(3);
      expect(result.entries[0]).toEqual({ kind: "text", content: "Working on it..." });
      expect(result.entries[1]).toEqual({ kind: "text", content: "Done!" });
      expect(result.entries[2]).toEqual({ kind: "tool", content: "Write: out.txt" });
      expect(result.newOffset).toBeGreaterThan(0);
    });

    it("respects byte offset for incremental reads", () => {
      const file = path.join(tmpDir, "session.jsonl");
      const line1 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "First" }] },
      });
      fs.writeFileSync(file, line1 + "\n");
      const firstSize = fs.statSync(file).size;

      const line2 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Second" }] },
      });
      fs.appendFileSync(file, line2 + "\n");

      const result = parseNewEntries(file, firstSize);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.content).toBe("Second");
    });

    it("skips Read/Glob/Grep tool calls", () => {
      const file = path.join(tmpDir, "session.jsonl");
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
            { type: "tool_use", name: "Glob", input: { pattern: "*.ts" } },
            { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
            { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      });
      fs.writeFileSync(file, line + "\n");

      const result = parseNewEntries(file, 0);
      // Only Bash should be reported; Read/Glob/Grep are noise
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toEqual({ kind: "tool", content: "Exec: ls -la" });
    });
  });

  describe("extractFinalResult", () => {
    it("returns empty string for non-existent file", () => {
      expect(extractFinalResult("/nonexistent")).toBe("");
    });

    it("extracts text after last-prompt marker", () => {
      const file = path.join(tmpDir, "session.jsonl");
      const lines = [
        // Old run
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Old result" }] } }),
        // New run boundary
        JSON.stringify({ type: "last-prompt" }),
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Do something" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Here is the result." }] } }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "All done." }] },
        }),
      ];
      fs.writeFileSync(file, lines.join("\n") + "\n");

      const result = extractFinalResult(file);
      expect(result).toContain("Here is the result.");
      expect(result).toContain("All done.");
      expect(result).not.toContain("Old result");
    });

    it("skips content after compaction events", () => {
      const file = path.join(tmpDir, "session.jsonl");
      // Simulate a compaction: user message with >50 content blocks
      const bigContent = Array.from({ length: 60 }, (_, i) => ({ type: "text", text: `block ${i}` }));
      const lines = [
        JSON.stringify({ type: "last-prompt" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Before compaction" }] } }),
        JSON.stringify({ type: "user", message: { content: bigContent } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Compaction summary - should skip" }] } }),
      ];
      fs.writeFileSync(file, lines.join("\n") + "\n");

      const result = extractFinalResult(file);
      expect(result).toContain("Before compaction");
      expect(result).not.toContain("Compaction summary");
    });
  });
});
