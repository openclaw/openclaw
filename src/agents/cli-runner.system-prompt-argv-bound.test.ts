import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import {
  createManagedRun,
  restoreCliRunnerPrepareTestDeps,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { resetClaudeLiveSessionsForTest } from "./cli-runner/claude-live-session.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

beforeEach(() => {
  resetAgentEventsForTest();
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
  restoreCliRunnerPrepareTestDeps();
  supervisorSpawnMock.mockClear();
});

afterEach(() => {
  resetClaudeLiveSessionsForTest();
  replyRunTesting.resetReplyRunRegistry();
});

// Windows enforces a hard ~32,767-char command-line limit (CreateProcessW
// MAX_COMMAND_LINE). A claude-cli backend that inlines the system prompt via
// `--append-system-prompt` blows past it as soon as workspace context
// approaches that size, and Node's child_process.spawn surfaces the failure
// as `spawn ENAMETOOLONG` long before Claude Code starts. f7b71abf48
// ("fix(agents): pass Claude system prompt via file") routes the prompt
// through `--append-system-prompt-file <path>` whenever the backend exposes
// `systemPromptFileArg`, sidestepping the limit entirely. This test pins
// that boundary: with a system prompt large enough to break the inline path
// on Windows, the argv that reaches the supervisor must stay well below the
// OS limit and the prompt body must never appear in argv.
//
// Regression target: https://github.com/openclaw/openclaw/issues/71600
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

function buildLargeSystemPromptContext(systemPrompt: string): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    modelArg: "--model",
    sessionArg: "--session-id",
    sessionMode: "always" as const,
    systemPromptFileArg: "--append-system-prompt-file",
    systemPromptWhen: "first" as const,
    serialize: true,
  };
  return {
    params: {
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 1_000,
      runId: "run-system-prompt-argv-bound",
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: true,
      pluginId: "anthropic",
    },
    preparedBackend: { backend, env: {} },
    reusableCliSession: {},
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt,
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function joinedArgvLength(argv: string[]): number {
  // Windows treats the joined command line as a single string separated by
  // spaces. This mirrors what CreateProcessW measures against the limit;
  // small over-counts from quoting are fine for a defensive bound.
  return argv.join(" ").length;
}

describe("claude-cli system prompt argv length bound (#71600)", () => {
  it("keeps argv under the Windows command-line limit even with a 40k-char system prompt", async () => {
    // 40k chars: typical workspace-context-heavy prompt that broke the inline
    // path on Windows in #71600. Use a non-repeating-but-deterministic payload
    // so any leak into argv is detectable by substring search.
    const largeSystemPrompt = `BEGIN-PROMPT-MARKER ${"x".repeat(40_000)} END-PROMPT-MARKER`;

    let capturedArgv: string[] = [];
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      capturedArgv = input.argv ?? [];
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(buildLargeSystemPromptContext(largeSystemPrompt));

    expect(capturedArgv.length).toBeGreaterThan(0);
    expect(joinedArgvLength(capturedArgv)).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);

    // Defense: even if argv length stayed under the limit by accident (e.g.
    // truncation, placeholder substitution), the prompt body itself must
    // never appear in argv. The file-based path is the only correct way to
    // ship it.
    const argvText = capturedArgv.join(" ");
    expect(argvText).not.toContain("BEGIN-PROMPT-MARKER");
    expect(argvText).not.toContain("END-PROMPT-MARKER");
  });

  it("uses --append-system-prompt-file with a temp path for the large prompt", async () => {
    const largeSystemPrompt = `LARGE-PROMPT-MARKER ${"y".repeat(40_000)}`;

    let systemPromptPath = "";
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { argv?: string[] };
      const idx = input.argv?.indexOf("--append-system-prompt-file") ?? -1;
      expect(idx).toBeGreaterThanOrEqual(0);
      systemPromptPath = input.argv?.[idx + 1] ?? "";
      expect(systemPromptPath).toContain("openclaw-cli-system-prompt-");
      await expect(fs.readFile(systemPromptPath, "utf-8")).resolves.toBe(largeSystemPrompt);
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    await executePreparedCliRun(buildLargeSystemPromptContext(largeSystemPrompt));

    // Temp file is cleaned up after the run.
    await expect(fs.access(systemPromptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
