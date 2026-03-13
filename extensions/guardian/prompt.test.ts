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

    it("treats tool results as DATA", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("[tool: ...]");
      expect(prompt).toContain("DATA");
    });

    it("includes memory results guideline", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("memory");
      expect(prompt).toContain("tampered");
    });

    it("includes standing instructions guideline with poisoning warning", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("standing instructions");
      expect(prompt).toContain("injected");
    });

    it("includes available skills guideline with poisoning warning", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("available skill");
      expect(prompt).toContain("malicious skill");
    });

    it("treats user messages as the ultimate authority", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("ultimate authority");
      expect(prompt).toContain("indirectly poisoned");
    });

    it("blocks actions where poisoned context contradicts user intent", () => {
      const prompt = buildGuardianSystemPrompt();
      expect(prompt).toContain("contradicts or has no connection");
      expect(prompt).toContain("poisoned context");
    });
  });

  describe("buildGuardianUserPrompt", () => {
    it("includes conversation turns with user messages", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
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
        undefined,
        undefined,
        undefined,
        [{ user: "Test" }],
        "write_file",
        { path: "/tmp/test", content: longValue },
        100,
      );

      expect(prompt).toContain("...(truncated)");
    });

    it("handles empty conversation turns", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [],
        "exec",
        { command: "ls" },
        500,
      );

      expect(prompt).toContain("(no recent conversation available)");
    });

    it("handles arguments that cannot be serialized", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [{ user: "Test" }],
        "exec",
        circular,
        500,
      );

      expect(prompt).toContain("(unable to serialize arguments)");
    });

    it("ends with a single-line response instruction", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [{ user: "Test" }],
        "exec",
        { command: "ls" },
        500,
      );

      expect(prompt).toContain("Reply with a single line: ALLOW: <reason> or BLOCK: <reason>");
    });

    it("includes session summary when provided", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        "User has been deploying a web app and configuring nginx",
        [{ user: "Yes go ahead" }],
        "exec",
        { command: "make build" },
        500,
      );

      expect(prompt).toContain("## Session summary (older context):");
      expect(prompt).toContain("User has been deploying a web app and configuring nginx");
      expect(prompt).toContain("## Recent conversation (most recent last):");
      expect(prompt).toContain('User: "Yes go ahead"');
    });

    it("omits summary section when summary is undefined", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [{ user: "Test" }],
        "exec",
        { command: "ls" },
        500,
      );

      expect(prompt).not.toContain("Session summary");
    });

    it("uses 'Recent conversation' header when turns exist", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [{ user: "Hello" }],
        "exec",
        { command: "ls" },
        500,
      );

      expect(prompt).toContain("## Recent conversation (most recent last):");
    });

    it("includes standing instructions when provided", () => {
      const prompt = buildGuardianUserPrompt(
        "- Always copy reports to Google Drive\n- Never modify production database",
        undefined,
        undefined,
        [{ user: "Generate report" }],
        "exec",
        { command: "cp report.pdf /mnt/gdrive/" },
        500,
      );

      expect(prompt).toContain("## Standing instructions (user-configured rules):");
      expect(prompt).toContain("Always copy reports to Google Drive");
      expect(prompt).toContain("Never modify production database");
    });

    it("omits standing instructions section when undefined", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [{ user: "Test" }],
        "exec",
        { command: "ls" },
        500,
      );

      expect(prompt).not.toContain("Standing instructions");
    });

    it("includes available skills when provided", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        "- deploy: Deploy the project to production\n- review-pr: Review a pull request",
        undefined,
        [{ user: "Deploy my project" }],
        "exec",
        { command: "make deploy" },
        500,
      );

      expect(prompt).toContain("## Available skills (agent capabilities):");
      expect(prompt).toContain("deploy: Deploy the project to production");
      expect(prompt).toContain("review-pr: Review a pull request");
    });

    it("omits available skills section when undefined", () => {
      const prompt = buildGuardianUserPrompt(
        undefined,
        undefined,
        undefined,
        [{ user: "Test" }],
        "exec",
        { command: "ls" },
        500,
      );

      expect(prompt).not.toContain("Available skills");
    });

    it("includes all sections in correct order when all are present", () => {
      const prompt = buildGuardianUserPrompt(
        "- Copy reports to Google Drive",
        "- deploy: Deploy the project",
        "User is generating monthly reports",
        [{ user: "Generate the PDF" }],
        "write_file",
        { path: "/tmp/report.pdf" },
        500,
      );

      const instructionsIdx = prompt.indexOf("Standing instructions");
      const skillsIdx = prompt.indexOf("Available skills");
      const summaryIdx = prompt.indexOf("Session summary");
      const conversationIdx = prompt.indexOf("Recent conversation");
      const toolIdx = prompt.indexOf("Tool call:");

      expect(instructionsIdx).toBeLessThan(skillsIdx);
      expect(skillsIdx).toBeLessThan(summaryIdx);
      expect(summaryIdx).toBeLessThan(conversationIdx);
      expect(conversationIdx).toBeLessThan(toolIdx);
    });
  });
});
