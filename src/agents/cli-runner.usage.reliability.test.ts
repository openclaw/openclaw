import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSessionEntrySync,
  loadTranscriptEvents,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  restoreCliRunnerTestDeps,
  runPreparedCliAgent as runPreparedCliAgentCore,
  setCliRunnerTestDeps,
} from "./cli-runner.js";
import { createManagedRun, supervisorSpawnMock } from "./cli-runner.test-support.js";
import { wrapPreparedCliRunWithTestAdmission } from "./cli-runner/execute.test-support.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

vi.mock("../gateway/mcp-http.loopback-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/mcp-http.loopback-runtime.js")>();
  return {
    ...actual,
    waitForMcpLoopbackToolCallCaptureIdle: (
      captureKey: string,
      options: Parameters<typeof actual.waitForMcpLoopbackToolCallCaptureIdle>[1],
    ) =>
      actual.waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
        ...options,
        admissionGraceMs: 0,
      }),
  };
});
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));
vi.mock("../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
  resolveModelOverridePolicy: vi.fn(),
  setTtsMachinePrefsPathResolver: vi.fn(),
}));

const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentCore);

function createContext(params: {
  dir: string;
  target: SessionTranscriptRuntimeTarget;
}): PreparedCliRunContext {
  const runId = "run-claude-turn-usage";
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
      admittedRunContext: createTestAdmittedRunContext(runId),
      sessionId: params.target.sessionId,
      sessionKey: params.target.sessionKey,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "opus",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId,
    },
    started: Date.now(),
    workspaceDir: params.dir,
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "anthropic",
    },
    executionTarget: { kind: "process" },
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "opus",
    normalizedModel: "opus",
    contextWindowInfo: { tokens: 150_000, referenceTokens: 200_000, source: "modelsConfig" },
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
}

describe("CLI runner terminal usage persistence", () => {
  beforeEach(() => {
    supervisorSpawnMock.mockReset();
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: async () => false,
      delay: async () => {},
    });
  });

  afterEach(() => {
    restoreCliRunnerTestDeps();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.useRealTimers();
  });

  it("persists terminal Claude usage while keeping last-call context", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-usage-")));
    const sessionTarget: SessionTranscriptRuntimeTarget = {
      agentId: "main",
      sessionId: "s1",
      sessionKey: "agent:main:main",
      storePath: path.join(dir, "agents", "main", "sessions", "sessions.json"),
    };
    ensureSessionEntrySync(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: Date.now(),
    });
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: [
          JSON.stringify({
            type: "assistant",
            message: {
              id: "msg-first-call",
              content: [{ type: "text", text: "Checking." }],
              usage: { input_tokens: 4, output_tokens: 15, cache_read_input_tokens: 27_255 },
            },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              id: "msg-last-call",
              content: [{ type: "text", text: "done" }],
              usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 27_376 },
            },
          }),
          JSON.stringify({
            type: "result",
            subtype: "success",
            result: "done",
            usage: { input_tokens: 6, output_tokens: 77, cache_read_input_tokens: 54_631 },
          }),
        ].join("\n"),
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );
    try {
      const context = createContext({ dir, target: sessionTarget });
      context.preparedBackend.backend = {
        ...context.preparedBackend.backend,
        output: "jsonl",
        input: "stdin",
        jsonlDialect: "claude-stream-json",
      };
      context.backendResolved.config = context.preparedBackend.backend;
      Object.assign(context.params, {
        sessionFile: sessionTarget.sessionKey,
        sessionTarget,
        storePath: sessionTarget.storePath,
        workspaceDir: dir,
        persistAssistantTranscript: true,
      });
      context.hadSessionFile = true;
      const result = await runPreparedCliAgent(context);
      expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({ output: 1, cacheRead: 27_376 });
      const messages = (await loadTranscriptEvents(sessionTarget)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toHaveLength(1);
      expect((messages[0] as { usage?: unknown }).usage).toEqual({
        input: 6,
        output: 77,
        cacheRead: 54_631,
        cacheWrite: 0,
        totalTokens: 54_714,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        contextUsage: { state: "available", promptTokens: 27_378, totalTokens: 27_379 },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
