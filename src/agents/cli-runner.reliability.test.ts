import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing as replyRunTesting,
  createReplyOperation,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(() => null),
  };
});

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function createSessionFile(params?: { history?: Array<{ role: "user"; content: string }> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-hooks-"));
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: "session-test",
      timestamp: new Date(0).toISOString(),
      cwd: dir,
    })}\n`,
    "utf-8",
  );
  const sessionManager = SessionManager.open(sessionFile);
  for (const entry of params?.history ?? []) {
    sessionManager.appendMessage({
      role: entry.role,
      content: entry.content,
      timestamp: Date.now(),
    });
  }
  return { dir, sessionFile };
}

function buildPreparedContext(params?: {
  sessionKey?: string;
  cliSessionId?: string;
  runId?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "codex",
    args: ["exec", "--json"],
    output: "text" as const,
    input: "arg" as const,
    modelArg: "--model",
    sessionMode: "existing" as const,
    serialize: true,
  };
  return {
    params: {
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "codex-cli",
      model: "gpt-5.4",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: params?.runId ?? "run-2",
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "codex-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "openai",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: params?.cliSessionId ? { sessionId: params.cliSessionId } : {},
    modelId: "gpt-5.4",
    normalizedModel: "gpt-5.4",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

describe("runCliAgent reliability", () => {
  afterEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    mockGetGlobalHookRunner.mockReset();
  });

  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-2" }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "no-output-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          sessionKey: "agent:main:main",
          cliSessionId: "thread-123",
          runId: "run-2b",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(opts).toMatchObject({ sessionKey: "agent:main:main" });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "overall-timeout",
        exitCode: null,
        exitSignal: "SIGKILL",
        durationMs: 200,
        stdout: "",
        stderr: "",
        timedOut: true,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-3" }),
        "thread-123",
      ),
    ).rejects.toThrow("exceeded timeout");
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    supervisorSpawnMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "session expired",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 150,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(
      runPreparedCliAgent(
        buildPreparedContext({
          sessionKey: "agent:main:subagent:retry",
          runId: "run-retry-failure",
          cliSessionId: "thread-123",
        }),
      ),
    ).rejects.toThrow("rate limit exceeded");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });

  it("returns the assembled CLI prompt in meta for raw trace consumers", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      bootstrapPromptWarningLines: ["Warning: prompt budget low."],
    });

    expect(result.meta.finalPromptText).toContain("Warning: prompt budget low.");
    expect(result.meta.finalPromptText).toContain("hi");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
    expect(result.meta.executionTrace).toMatchObject({
      winnerProvider: "codex-cli",
      winnerModel: "gpt-5.4",
      fallbackUsed: false,
      runner: "cli",
      attempts: [{ provider: "codex-cli", model: "gpt-5.4", result: "success" }],
    });
    expect(result.meta.requestShaping).toMatchObject({
      thinking: "low",
    });
    expect(result.meta.completion).toMatchObject({
      finishReason: "stop",
      stopReason: "completed",
      refusal: false,
    });
  });

  it("reports CLI reply backends as streaming until the managed run finishes", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "s1",
      resetTriggered: false,
    });
    operation.setPhase("running");
    let finishRun: (() => void) | undefined;
    const waitForExit = new Promise<
      Awaited<ReturnType<ReturnType<typeof createManagedRun>["wait"]>>
    >((resolve) => {
      finishRun = () => {
        resolve({
          reason: "exit",
          exitCode: 0,
          exitSignal: null,
          durationMs: 50,
          stdout: "hello from cli",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        });
      };
    });
    supervisorSpawnMock.mockResolvedValueOnce({
      ...createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "unused",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
      wait: vi.fn(() => waitForExit),
    });

    const run = executePreparedCliRun({
      ...buildPreparedContext({ sessionKey: "agent:main:main" }),
      params: {
        ...buildPreparedContext({ sessionKey: "agent:main:main" }).params,
        replyOperation: operation,
      },
    });

    await vi.waitFor(() => {
      expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(true);
    });

    finishRun?.();
    await expect(run).resolves.toMatchObject({ text: "hello from cli" });
    expect(replyRunRegistry.isStreaming("agent:main:main")).toBe(false);
    operation.complete();
  });

  it("keeps raw assistant output separate from transformed visible CLI output", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    const result = await runPreparedCliAgent({
      ...buildPreparedContext(),
      backendResolved: {
        ...buildPreparedContext().backendResolved,
        textTransforms: {
          output: [{ from: "hello", to: "goodbye" }],
        },
      },
    });

    expect(result.payloads).toEqual([{ text: "goodbye from cli" }]);
    expect(result.meta.finalAssistantVisibleText).toBe("goodbye from cli");
    expect(result.meta.finalAssistantRawText).toBe("hello from cli");
  });

  it("emits llm_input, llm_output, and agent_end hooks for successful CLI runs", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["llm_input", "llm_output", "agent_end"].includes(hookName),
      ),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
    const { dir, sessionFile } = createSessionFile();

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "hello from cli",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await runPreparedCliAgent({
        ...buildPreparedContext(),
        params: {
          ...buildPreparedContext().params,
          sessionFile,
          workspaceDir: dir,
          sessionKey: "agent:main:main",
          agentId: "main",
          messageProvider: "acp",
          messageChannel: "telegram",
          trigger: "user",
        },
      });

      await vi.waitFor(() => {
        expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runLlmOutput).toHaveBeenCalledTimes(1);
        expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
      });

      expect(hookRunner.runLlmInput).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-2",
          sessionId: "s1",
          provider: "codex-cli",
          model: "gpt-5.4",
          prompt: "hi",
          systemPrompt: "You are a helpful assistant.",
          historyMessages: expect.any(Array),
          imagesCount: 0,
        }),
        expect.objectContaining({
          runId: "run-2",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "s1",
          workspaceDir: dir,
          messageProvider: "acp",
          trigger: "user",
          channelId: "telegram",
        }),
      );
      expect(hookRunner.runLlmOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-2",
          sessionId: "s1",
          provider: "codex-cli",
          model: "gpt-5.4",
          assistantTexts: ["hello from cli"],
          lastAssistant: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "hello from cli" }],
            provider: "codex-cli",
            model: "gpt-5.4",
          }),
        }),
        expect.any(Object),
      );
      expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          messages: [
            { role: "user", content: "hi", timestamp: expect.any(Number) },
            expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "hello from cli" }],
            }),
          ],
        }),
        expect.any(Object),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits agent_end with failure details when the CLI run fails", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => ["llm_input", "agent_end"].includes(hookName)),
      runLlmInput: vi.fn(async () => undefined),
      runLlmOutput: vi.fn(async () => undefined),
      runAgentEnd: vi.fn(async () => undefined),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 1,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "rate limit exceeded",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(runPreparedCliAgent(buildPreparedContext())).rejects.toThrow(
      "rate limit exceeded",
    );

    await vi.waitFor(() => {
      expect(hookRunner.runLlmInput).toHaveBeenCalledTimes(1);
      expect(hookRunner.runLlmOutput).not.toHaveBeenCalled();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledTimes(1);
    });

    expect(hookRunner.runAgentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "rate limit exceeded",
        messages: [{ role: "user", content: "hi", timestamp: expect.any(Number) }],
      }),
      expect.any(Object),
    );
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });
});
