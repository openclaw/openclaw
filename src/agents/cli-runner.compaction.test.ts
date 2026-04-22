import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeClaudeProjectPath,
  isSafeClaudeCliSessionId,
  resetCliRunnerCompactionTestDeps,
  runPreparedCliAgent,
  setCliRunnerCompactionTestDeps,
} from "./cli-runner.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

const executePreparedCliRunMock = vi.hoisted(() => vi.fn());
const resolveContextEngineMock = vi.hoisted(() => vi.fn());
const runContextEngineMaintenanceMock = vi.hoisted(() => vi.fn());
const shouldPreemptivelyCompactBeforePromptMock = vi.hoisted(() => vi.fn());

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

function buildPreparedContext(): PreparedCliRunContext {
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
      sessionId: "session-1",
      sessionKey: "agent:main:test",
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {} as PreparedCliRunContext["params"]["config"],
      contextTokenBudget: 4096,
      prompt: "hello from cli",
      provider: "codex-cli",
      model: "gpt-5.4",
      timeoutMs: 1000,
      runId: "run-1",
    },
    started: Date.now(),
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    contextTokenBudget: 4096,
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
    reusableCliSession: {},
    modelId: "gpt-5.4",
    normalizedModel: "gpt-5.4",
    systemPrompt: "You are helpful.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
  };
}

describe("CLI runner compaction parity", () => {
  beforeEach(() => {
    executePreparedCliRunMock.mockReset().mockResolvedValue({
      text: "ok",
      rawText: "ok",
      usage: { input: 10, output: 5, total: 15 },
    });
    resolveContextEngineMock.mockReset().mockResolvedValue({
      info: { id: "default", name: "Default" },
    });
    runContextEngineMaintenanceMock.mockReset().mockResolvedValue({
      changed: true,
      bytesFreed: 1024,
      rewrittenEntries: 2,
    });
    shouldPreemptivelyCompactBeforePromptMock.mockReset().mockReturnValue({
      route: "compact_only",
      shouldCompact: true,
      estimatedPromptTokens: 3500,
      promptBudgetBeforeReserve: 3000,
      overflowTokens: 500,
      toolResultReducibleChars: 0,
      effectiveReserveTokens: 512,
    });

    setCliRunnerCompactionTestDeps({
      accessSessionFile: vi.fn(async () => true),
      openSessionManager: vi.fn(
        () =>
          ({
            getBranch: () => [
              {
                type: "message",
                message: { role: "user", content: "existing turn", timestamp: 1 },
              },
            ],
            buildSessionContext: () => ({
              messages: [{ role: "user", content: "existing turn", timestamp: 1 }],
            }),
          }) as never,
      ),
      prepareSessionManagerForRun: vi.fn(async () => undefined),
      resolveContextEngine: resolveContextEngineMock,
      createPreparedEmbeddedPiSettingsManager: vi.fn(
        async () =>
          ({
            getCompactionReserveTokens: () => 512,
            getCompactionKeepRecentTokens: () => 0,
            applyOverrides: () => {},
          }) as never,
      ),
      applyPiAutoCompactionGuard: vi.fn(async () => ({ supported: true, disabled: false })),
      shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptMock,
      runContextEngineMaintenance: runContextEngineMaintenanceMock,
      resolveLiveToolResultMaxChars: vi.fn(async () => 20_000),
    });
  });

  afterEach(() => {
    resetCliRunnerCompactionTestDeps();
  });

  it("runs pre-turn compaction maintenance before executing a CLI turn", async () => {
    const resetReusableCliSession = vi.fn(async () => undefined);

    await runPreparedCliAgent({
      ...buildPreparedContext(),
      params: {
        ...buildPreparedContext().params,
        onResetReusableCliSession: resetReusableCliSession,
      },
    });

    expect(shouldPreemptivelyCompactBeforePromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello from cli",
        contextTokenBudget: 4096,
      }),
    );
    expect(runContextEngineMaintenanceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "compaction",
        sessionId: "session-1",
        sessionKey: "agent:main:test",
        sessionFile: "/tmp/session.jsonl",
        runtimeContext: expect.objectContaining({
          tokenBudget: 4096,
          currentTokenCount: 3500,
        }),
      }),
    );
    expect(resetReusableCliSession).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRunMock.mock.calls[0]?.[0]).toMatchObject({
      forceFreshSession: true,
      reseedPrompt: expect.stringContaining("<conversation_history>"),
    });
    expect(executePreparedCliRunMock.mock.calls[0]?.[0]?.reseedPrompt).toContain(
      "User: existing turn",
    );
    expect(executePreparedCliRunMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("rotates claude-cli sessions to a seeded resume target after compaction", async () => {
    const resetReusableCliSession = vi.fn(async () => undefined);
    setCliRunnerCompactionTestDeps({
      accessSessionFile: vi.fn(async () => true),
      openSessionManager: vi.fn(
        () =>
          ({
            getBranch: () => [
              {
                type: "message",
                message: { role: "user", content: "existing turn", timestamp: 1 },
              },
            ],
            buildSessionContext: () => ({
              messages: [
                { role: "user", content: "existing turn", timestamp: 1 },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "existing answer" }],
                  timestamp: 2,
                },
              ],
            }),
          }) as never,
      ),
      prepareSessionManagerForRun: vi.fn(async () => undefined),
      resolveContextEngine: resolveContextEngineMock,
      createPreparedEmbeddedPiSettingsManager: vi.fn(
        async () =>
          ({
            getCompactionReserveTokens: () => 512,
            getCompactionKeepRecentTokens: () => 0,
            applyOverrides: () => {},
          }) as never,
      ),
      applyPiAutoCompactionGuard: vi.fn(async () => ({ supported: true, disabled: false })),
      shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptMock,
      runContextEngineMaintenance: runContextEngineMaintenanceMock,
      resolveLiveToolResultMaxChars: vi.fn(async () => 20_000),
      realpath: vi.fn(async (value: string) => value),
      readFile: vi.fn(
        async () =>
          '{"sessionId":"old-session","cwd":"/tmp/workspace","version":"2.1.114","gitBranch":"HEAD","entrypoint":"sdk-cli","userType":"external","permissionMode":"bypassPermissions"}\n',
      ),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    });

    await runPreparedCliAgent({
      ...buildPreparedContext(),
      params: {
        ...buildPreparedContext().params,
        provider: "claude-cli",
        onResetReusableCliSession: resetReusableCliSession,
      },
      backendResolved: {
        ...buildPreparedContext().backendResolved,
        id: "claude-cli",
      },
      reusableCliSession: { sessionId: "old-session" },
    });

    expect(resetReusableCliSession).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRunMock).toHaveBeenCalledTimes(1);
    expect(executePreparedCliRunMock.mock.calls[0]?.[0]).toMatchObject({
      forceFreshSession: false,
      reseedPrompt: undefined,
    });
    expect(executePreparedCliRunMock.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("encodeClaudeProjectPath", () => {
  it("replaces every non-alphanumeric char with a single dash, matching Claude CLI v2.1.x", () => {
    expect(encodeClaudeProjectPath("/Users/jane/src/openclaw")).toBe("-Users-jane-src-openclaw");
    expect(encodeClaudeProjectPath("/tmp/a b.c_d")).toBe("-tmp-a-b-c-d");
  });

  it("preserves case and digits", () => {
    expect(encodeClaudeProjectPath("/Repo-42/MixedCase")).toBe("-Repo-42-MixedCase");
  });

  it("does not collapse consecutive separators (observed CLI behavior)", () => {
    expect(encodeClaudeProjectPath("/a//b")).toBe("-a--b");
  });

  it("is stable across repeated calls (roundtrip-equivalent on the encoded form)", () => {
    const encoded = encodeClaudeProjectPath("/Users/jane/src/openclaw");
    expect(encodeClaudeProjectPath(encoded)).toBe(encoded);
  });
});

describe("isSafeClaudeCliSessionId", () => {
  it("accepts canonical UUIDs", () => {
    expect(isSafeClaudeCliSessionId("0f2c9a7e-3b4d-4d21-9a11-1b2c3d4e5f6a")).toBe(true);
    expect(isSafeClaudeCliSessionId("0F2C9A7E-3B4D-4D21-9A11-1B2C3D4E5F6A")).toBe(true);
  });

  it("rejects path-traversal and separator characters", () => {
    expect(isSafeClaudeCliSessionId("../evil")).toBe(false);
    expect(isSafeClaudeCliSessionId("a/b")).toBe(false);
    expect(isSafeClaudeCliSessionId("a\\b")).toBe(false);
    expect(isSafeClaudeCliSessionId("../../etc/passwd")).toBe(false);
  });

  it("rejects empty or non-UUID shapes", () => {
    expect(isSafeClaudeCliSessionId("")).toBe(false);
    expect(isSafeClaudeCliSessionId("not-a-uuid")).toBe(false);
    expect(isSafeClaudeCliSessionId("0f2c9a7e-3b4d-4d21-9a11")).toBe(false);
    expect(isSafeClaudeCliSessionId("zzzzzzzz-3b4d-4d21-9a11-1b2c3d4e5f6a")).toBe(false);
  });
});
