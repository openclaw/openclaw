import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

const { executePreparedCliRunMock, loadCliSessionHistoryMessagesMock, getGlobalHookRunnerMock } =
  vi.hoisted(() => ({
    executePreparedCliRunMock: vi.fn(),
    loadCliSessionHistoryMessagesMock: vi.fn(),
    getGlobalHookRunnerMock: vi.fn(() => null),
  }));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

vi.mock("./cli-runner/session-history.js", () => ({
  loadCliSessionHistoryMessages: loadCliSessionHistoryMessagesMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

function textMessage(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  return {
    info: { id: "test-context-engine", name: "Test context engine" },
    ingest: vi.fn(async () => ({ ingested: true })),
    assemble: vi.fn(async (params) => ({
      messages: params.messages,
      estimatedTokens: 0,
    })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
    ...overrides,
  };
}

function createMaintenanceResult() {
  return {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
  };
}

function buildPreparedContext(contextEngine: ContextEngine): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["--print"],
    output: "text" as const,
    input: "arg" as const,
    sessionMode: "existing" as const,
    serialize: true,
  };

  return {
    params: {
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionFile: "session.jsonl",
      workspaceDir: "/tmp/openclaw-cli-context-engine-test",
      prompt: "visible ask",
      transcriptPrompt: "transcript visible ask",
      provider: "claude-cli",
      model: "sonnet-4.6",
      thinkLevel: "low",
      timeoutMs: 1_000,
      runId: "run-1",
    },
    started: Date.now(),
    workspaceDir: "/tmp/openclaw-cli-context-engine-test",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "anthropic",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {
      sessionId: "existing-external-cli-session",
    },
    contextEngine,
    modelId: "sonnet-4.6",
    normalizedModel: "sonnet-4.6",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function expectMessageText(message: AgentMessage | undefined, expected: string): void {
  expect(message).toBeDefined();
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    expect(content).toBe(expected);
    return;
  }
  expect(Array.isArray(content)).toBe(true);
  expect((content as unknown[] | undefined)?.[0]).toMatchObject({ type: "text", text: expected });
}

describe("runPreparedCliAgent context engine lifecycle", () => {
  beforeEach(() => {
    executePreparedCliRunMock.mockReset();
    executePreparedCliRunMock.mockResolvedValue({
      text: " final answer ",
      rawText: " final answer ",
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 7, total: 18 },
      finalPromptText: "prompt sent to cli",
    });
    loadCliSessionHistoryMessagesMock.mockReset();
    loadCliSessionHistoryMessagesMock.mockResolvedValue([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    getGlobalHookRunnerMock.mockReset();
    getGlobalHookRunnerMock.mockReturnValue(null);
  });

  it("finalizes successful CLI turns with the active context engine", async () => {
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, maintain, dispose });
    const context = buildPreparedContext(contextEngine);
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.sessionId).toBe("external-cli-session-1");
    expect(loadCliSessionHistoryMessagesMock).toHaveBeenCalledWith({
      sessionId: "openclaw-session-1",
      sessionFile: "session.jsonl",
      sessionKey: "agent:main:main",
      agentId: "main",
      config: undefined,
    });
    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionFile: "session.jsonl",
      prePromptMessageCount: 2,
      tokenBudget: undefined,
      runtimeContext: undefined,
    });
    expect(afterTurnParams?.messages).toHaveLength(4);
    expect(afterTurnParams?.messages.slice(0, 2)).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    expectMessageText(afterTurnParams?.messages[2], "transcript visible ask");
    expectMessageText(afterTurnParams?.messages[3], "final answer");
    expect(afterTurnParams?.messages[3]).toMatchObject({
      role: "assistant",
      provider: "claude-cli",
      model: "sonnet-4.6",
      usage: { input: 11, output: 7, total: 18 },
    });
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(maintain.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionFile: "session.jsonl",
      runtimeContext: {
        rewriteTranscriptEntries: expect.any(Function),
        llm: { complete: expect.any(Function) },
      },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("falls back to ingestBatch and still runs turn maintenance", async () => {
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 2,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ ingestBatch, maintain, dispose });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await runPreparedCliAgent(buildPreparedContext(contextEngine));

    expect(ingestBatch).toHaveBeenCalledTimes(1);
    const ingestBatchParams = ingestBatch.mock.calls[0]?.[0];
    expect(ingestBatchParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
    });
    expect(ingestBatchParams?.messages).toHaveLength(2);
    expectMessageText(ingestBatchParams?.messages[0], "transcript visible ask");
    expectMessageText(ingestBatchParams?.messages[1], "final answer");
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("does not finalize or maintain failed CLI attempts but still disposes the engine", async () => {
    executePreparedCliRunMock.mockRejectedValue(new Error("cli boom"));
    const afterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 0,
    }));
    const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () =>
      createMaintenanceResult(),
    );
    const dispose = vi.fn(async () => {});
    const contextEngine = createContextEngine({ afterTurn, ingestBatch, maintain, dispose });
    const { runPreparedCliAgent } = await import("./cli-runner.js");

    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(afterTurn).not.toHaveBeenCalled();
    expect(ingestBatch).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
