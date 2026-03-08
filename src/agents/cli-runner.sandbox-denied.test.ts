import { describe, expect, it } from "vitest";
import { detectSandboxDenied, parseCliJsonl } from "./cli-runner/helpers.js";

const CODEX_BACKEND = {
  command: "codex",
  args: ["exec", "--json"],
  output: "jsonl" as const,
  input: "arg" as const,
  sessionIdFields: ["thread_id"],
};

describe("detectSandboxDenied", () => {
  it("detects top-level error string mentioning sandbox policy", () => {
    const records = [{ error: "sandbox policy: write denied for /tmp/TEST_RO.md" }];
    expect(detectSandboxDenied(records)).toBe(true);
  });

  it("detects nested error.message mentioning sandbox denied", () => {
    const records = [{ error: { message: "Operation sandbox denied: cannot write file" } }];
    expect(detectSandboxDenied(records)).toBe(true);
  });

  it("detects item type error with sandbox text", () => {
    const records = [
      {
        item: {
          type: "error",
          text: "The file could not be written because the sandbox policy blocks writes in read-only mode.",
        },
      },
    ];
    expect(detectSandboxDenied(records)).toBe(true);
  });

  it("detects tool-call output reporting sandbox denial", () => {
    const records = [
      {
        item: {
          type: "tool_call_output",
          text: "sandbox policy: write to /workspace/TEST_RO.md denied",
        },
      },
    ];
    expect(detectSandboxDenied(records)).toBe(true);
  });

  it("detects command action with sandbox blocked status", () => {
    const records = [
      {
        item: {
          type: "command_execution",
          text: "write denied by sandbox read-only filesystem",
        },
      },
    ];
    expect(detectSandboxDenied(records)).toBe(true);
  });

  it("detects item with sandbox denied status field", () => {
    const records = [{ item: { type: "action", status: "sandbox_denied", text: "write file" } }];
    expect(detectSandboxDenied(records)).toBe(true);
  });

  it("does not flag normal message text that merely discusses sandboxing", () => {
    const records = [
      {
        item: {
          type: "message",
          text: "I would normally write a file here, but let me explain how sandbox policies work in Codex.",
        },
      },
    ];
    expect(detectSandboxDenied(records)).toBe(false);
  });

  it("does not flag empty records", () => {
    expect(detectSandboxDenied([])).toBe(false);
  });

  it("does not flag normal successful output", () => {
    const records = [
      {
        item: {
          type: "message",
          text: "I've created the file TEST_RO.md with the content 'hello'.",
        },
      },
      { usage: { input: 100, output: 50 } },
    ];
    expect(detectSandboxDenied(records)).toBe(false);
  });
});

describe("parseCliJsonl sandbox detection", () => {
  it("sets sandboxDenied when JSONL contains sandbox error item", () => {
    const jsonl = [
      JSON.stringify({ thread_id: "abc123" }),
      JSON.stringify({
        item: {
          type: "error",
          text: "sandbox policy: write denied for /workspace/TEST_RO.md",
        },
      }),
      JSON.stringify({
        item: {
          type: "message",
          text: "I was unable to write the file due to sandbox restrictions.",
        },
      }),
    ].join("\n");

    const result = parseCliJsonl(jsonl, CODEX_BACKEND);
    expect(result).not.toBeNull();
    expect(result!.sandboxDenied).toBe(true);
    expect(result!.sessionId).toBe("abc123");
  });

  it("detects sandboxDenied even when JSONL has no message-typed items (text-less denial)", () => {
    const jsonl = [
      JSON.stringify({ thread_id: "def456" }),
      JSON.stringify({
        item: {
          type: "tool_call_output",
          text: "sandbox policy: write to /workspace/TEST_RO.md denied",
        },
      }),
      JSON.stringify({ usage: { input_tokens: 80, output_tokens: 20 } }),
    ].join("\n");

    const result = parseCliJsonl(jsonl, CODEX_BACKEND);
    expect(result).not.toBeNull();
    expect(result!.sandboxDenied).toBe(true);
    expect(result!.text).toBe("");
    expect(result!.sessionId).toBe("def456");
  });

  it("does not set sandboxDenied for normal output", () => {
    const jsonl = [
      JSON.stringify({ thread_id: "abc123" }),
      JSON.stringify({
        item: { type: "message", text: "I've created the file successfully." },
      }),
    ].join("\n");

    const result = parseCliJsonl(jsonl, CODEX_BACKEND);
    expect(result).not.toBeNull();
    expect(result!.sandboxDenied).toBeUndefined();
  });
});
