import { describe, it, expect } from "vitest";
import { buildGuardianSystemPrompt, buildGuardianUserPrompt } from "./prompt.js";

describe("prompt", () => {
  describe("buildGuardianSystemPrompt", () => {
    it("returns a non-empty string", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe("string");
    });

    it("contains security rules", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("DATA");
      expect(prompt).toContain("ALLOW");
      expect(prompt).toContain("BLOCK");
    });

    it("warns about assistant replies as untrusted context", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("Assistant replies");
      expect(prompt).toContain("poisoned");
    });

    it("enforces strict single-line output format", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("ONLY a single line");
      expect(prompt).toContain("Do NOT output any other text");
      expect(prompt).toContain("Do NOT change your mind");
    });

    it("includes decision guidelines for read vs write operations", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("read-only operations");
      expect(prompt).toContain("send/exfiltrate");
    });
  });

  describe("buildGuardianUserPrompt", () => {
    it("includes conversation turns with user messages", () => {
      const prompt = buildGuardianUserPrompt(
        [{ user: "Hello" }, { user: "Send a message to Alice" }],
        "message_send",
        { target: "Alice", message: "Hello" },
        500,
      );

      expect(prompt).toContain('User: "Hello"');
      expect(prompt).toContain('User: "Send a message to Alice"');
    });

    it("includes assistant context in conversation turns", () => {
      const prompt = buildGuardianUserPrompt(
        [
          { user: "Clean up temp files" },
          {
            user: "Yes",
            assistant: "I found 5 old temp files. Should I delete them?",
          },
        ],
        "exec",
        { command: "rm /tmp/old-*.log" },
        500,
      );

      expect(prompt).toContain('Assistant: "I found 5 old temp files. Should I delete them?"');
      expect(prompt).toContain('User: "Yes"');
    });

    it("includes tool name and arguments", () => {
      const prompt = buildGuardianUserPrompt(
        [{ user: "Check disk usage" }],
        "exec",
        { command: "df -h" },
        500,
      );

      expect(prompt).toContain("Tool: exec");
      expect(prompt).toContain('"command":"df -h"');
    });

    it("truncates long arguments", () => {
      const longValue = "x".repeat(1000);
      const prompt = buildGuardianUserPrompt(
        [{ user: "Test" }],
        "write_file",
        { path: "/tmp/test", content: longValue },
        100,
      );

      expect(prompt).toContain("...(truncated)");
      // The arguments section should not contain the full 1000-char value
      const argsLine = prompt.split("\n").find((l) => l.startsWith("Arguments:"));
      expect(argsLine).toBeTruthy();
      // 100 chars + "...(truncated)" + "Arguments: " prefix
      expect(argsLine!.length).toBeLessThan(200);
    });

    it("handles empty conversation turns", () => {
      const prompt = buildGuardianUserPrompt([], "exec", { command: "ls" }, 500);

      expect(prompt).toContain("(no recent conversation available)");
    });

    it("handles arguments that cannot be serialized", () => {
      // Create a circular reference
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const prompt = buildGuardianUserPrompt([{ user: "Test" }], "exec", circular, 500);

      expect(prompt).toContain("(unable to serialize arguments)");
    });

    it("ends with a single-line response instruction", () => {
      const prompt = buildGuardianUserPrompt([{ user: "Test" }], "exec", { command: "ls" }, 500);

      expect(prompt).toContain("Reply with a single line: ALLOW: <reason> or BLOCK: <reason>");
    });
  });
});
