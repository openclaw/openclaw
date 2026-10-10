// Regression #80374: preserve argv-level system prompt delivery on resumed turns.
import { describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { buildCliArgs, resolveSystemPromptUsage } from "./helpers.js";

const BACKEND_ALWAYS: CliBackendConfig = {
  command: "claude",
  systemPromptFileArg: "--append-system-prompt-file",
  systemPromptWhen: "always",
  sessionArgs: ["--session-id", "{sessionId}"],
  modelArg: "--model",
  input: "stdin",
  output: "jsonl",
  liveSession: "claude-stdio",
};
const BACKEND_FIRST: CliBackendConfig = { ...BACKEND_ALWAYS, systemPromptWhen: "first" };

const SYSTEM_PROMPT = "You are a test assistant. Append SYSTEM-PROOF-ACTIVE after every reply.";
const PROMPT_FILE = "/tmp/test-system-prompt.txt";

describe("resolveSystemPromptUsage — issue #80374", () => {
  it("legacy 'first': returns null on resumed session (prompt dropped)", () => {
    const result = resolveSystemPromptUsage({
      backend: BACKEND_FIRST,
      isNewSession: false,
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(result).toBeNull();
  });

  it("new 'always': returns the prompt on resumed session (issue #80374)", () => {
    const result = resolveSystemPromptUsage({
      backend: BACKEND_ALWAYS,
      isNewSession: false,
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(result).toBe(SYSTEM_PROMPT);
  });

  it("returns the prompt on fresh session for both 'first' and 'always'", () => {
    for (const backend of [BACKEND_FIRST, BACKEND_ALWAYS]) {
      const result = resolveSystemPromptUsage({
        backend,
        isNewSession: true,
        systemPrompt: SYSTEM_PROMPT,
      });
      expect(result, `systemPromptWhen=${backend.systemPromptWhen}`).toBe(SYSTEM_PROMPT);
    }
  });

  it("returns null when systemPromptWhen='never' regardless of session state", () => {
    for (const isNew of [true, false]) {
      const result = resolveSystemPromptUsage({
        backend: { ...BACKEND_ALWAYS, systemPromptWhen: "never" },
        isNewSession: isNew,
        systemPrompt: SYSTEM_PROMPT,
      });
      expect(result, `isNew=${String(isNew)}`).toBeNull();
    }
  });
});

describe("buildCliArgs — issue #80374", () => {
  const promptArgs = {
    baseArgs: ["-p", "--output-format", "stream-json"],
    modelId: "claude-haiku-4-5",
    sessionId: "test-session-id",
    systemPrompt: SYSTEM_PROMPT,
    systemPromptFilePath: PROMPT_FILE,
    useResume: true,
  };

  it("legacy 'first': omits --append-system-prompt-file on resume", () => {
    const args = buildCliArgs({
      backend: BACKEND_FIRST,
      ...promptArgs,
    });
    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain(PROMPT_FILE);
  });

  it("soft system-prompt drift includes --append-system-prompt-file on legacy resume", () => {
    const args = buildCliArgs({
      backend: BACKEND_FIRST,
      ...promptArgs,
      sendSystemPromptOnResume: true,
    });
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain(PROMPT_FILE);
  });

  it("new 'always': includes --append-system-prompt-file on resume (issue #80374)", () => {
    const args = buildCliArgs({
      backend: BACKEND_ALWAYS,
      ...promptArgs,
    });
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain(PROMPT_FILE);
  });

  it("appends a configured fork argument only to the marked resume", () => {
    const backend = {
      ...BACKEND_ALWAYS,
      forkArg: "--fork-session",
      resumeAtArg: "--resume-session-at",
    };
    const resumed = buildCliArgs({
      backend,
      baseArgs: ["--resume", "source-session"],
      modelId: "claude-haiku-4-5",
      sessionId: "source-session",
      useResume: true,
      forkResume: true,
      resumeAt: "assistant-before-turn",
    });
    const subsequent = buildCliArgs({
      backend,
      baseArgs: ["--resume", "forked-session"],
      modelId: "claude-haiku-4-5",
      sessionId: "forked-session",
      useResume: true,
      forkResume: false,
    });
    expect(resumed).toContain("--fork-session");
    expect(resumed).toEqual(
      expect.arrayContaining(["--resume-session-at", "assistant-before-turn"]),
    );
    expect(subsequent).not.toContain("--fork-session");
    expect(subsequent).not.toContain("--resume-session-at");
  });

  it("rejects a marked fork when the backend has no fork argument", () => {
    expect(() =>
      buildCliArgs({
        backend: BACKEND_ALWAYS,
        baseArgs: ["--resume", "source-session"],
        modelId: "claude-haiku-4-5",
        sessionId: "source-session",
        useResume: true,
        forkResume: true,
      }),
    ).toThrow("does not support forked session resume");
  });

  it("rejects a checkpoint when the backend has no resume-at argument", () => {
    expect(() =>
      buildCliArgs({
        backend: { ...BACKEND_ALWAYS, forkArg: "--fork-session" },
        baseArgs: ["--resume", "source-session"],
        modelId: "claude-haiku-4-5",
        sessionId: "source-session",
        useResume: true,
        forkResume: true,
        resumeAt: "assistant-before-turn",
      }),
    ).toThrow("does not support checkpointed session resume");
  });
});
