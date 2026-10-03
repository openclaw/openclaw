/** Tests CLI runner integration with context-engine lifecycle hooks. */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextEngine } from "../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";
import { waitForDeferredTurnMaintenanceForSession } from "./embedded-agent-runner/context-engine-maintenance.js";

const { executeMock, historyMock, hookHistoryMock, hookRunnerMock, beforeReplyMock, prepareMock } =
  vi.hoisted(() => ({
    executeMock: vi.fn(),
    historyMock: vi.fn(),
    hookHistoryMock: vi.fn(),
    hookRunnerMock: vi.fn(() => null),
    beforeReplyMock: vi.fn(async () => undefined),
    prepareMock: vi.fn(),
  }));

let runCliAgent: typeof import("./cli-runner.js").runCliAgent;
let runPreparedCliAgent: typeof import("./cli-runner.js").runPreparedCliAgent;
let restoreCliRunnerTestDeps: typeof import("./cli-runner.js").restoreCliRunnerTestDeps;
let setCliRunnerTestDeps: typeof import("./cli-runner.js").setCliRunnerTestDeps;

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executeMock,
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: prepareMock,
}));

vi.mock("./cli-runner/session-history.js", () => ({
  loadCliSessionContextEngineMessages: historyMock,
  loadCliSessionHistoryMessages: hookHistoryMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hookRunnerMock,
}));

vi.mock("../plugins/before-agent-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/before-agent-reply.js")>()),
  runBeforeAgentReplyForTurn: beforeReplyMock,
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

function createLifecycle() {
  return {
    bootstrap: vi.fn<NonNullable<ContextEngine["bootstrap"]>>(async () => ({ bootstrapped: true })),
    afterTurn: vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {}),
    maintain: vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    })),
    dispose: vi.fn(async () => {}),
  };
}

// The context engine reads history from the canonical store, so the runner must forward
// the exact target it was given rather than re-deriving one from a session file token.
const sessionTarget = {
  agentId: "main",
  sessionId: "openclaw-session-1",
  sessionKey: "agent:main:main",
  storePath: "/tmp/openclaw-cli-context-engine-test/openclaw-agent.sqlite",
} as const;

function createAdmittedCliRecorder(entryId: string) {
  const message = { role: "user" as const, content: "visible ask", timestamp: 1 };
  const recorder = createUserTurnTranscriptRecorder({ message, target: async () => undefined });
  const admission = {
    ...sessionTarget,
    generation: "generation-1",
    entryId,
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: `${entryId}-turn`,
    role: "user" as const,
  };
  recorder.markRuntimePersisted(message, admission);
  return { recorder, admission };
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
      admittedRunContext: createTestAdmittedRunContext("run-1"),
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      agentId: "main",
      sessionFile: "session.jsonl",
      sessionTarget,
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
    startedMonotonicMs: performance.now(),
    workspaceDir: "/tmp/openclaw-cli-context-engine-test",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: false,
      pluginId: "anthropic",
    },
    executionTarget: { kind: "process" },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: {
      mode: "reuse",
      sessionId: "existing-external-cli-session",
    },
    hadSessionFile: true,
    contextEngineConfig: {},
    contextEngine,
    contextEngineTurnPrompt: "transcript visible ask",
    modelId: "sonnet-4.6",
    normalizedModel: "sonnet-4.6",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
}

describe("runPreparedCliAgent context engine lifecycle", () => {
  beforeAll(async () => {
    ({ restoreCliRunnerTestDeps, runCliAgent, runPreparedCliAgent, setCliRunnerTestDeps } =
      await import("./cli-runner.js"));
  });

  beforeEach(() => {
    executeMock.mockReset().mockResolvedValue({
      text: " final answer ",
      rawText: " final answer ",
      sessionId: "external-cli-session-1",
      usage: { input: 11, output: 7, total: 18 },
      diagnosticUsage: { input: 21, output: 9, total: 30 },
      finalPromptText: "prompt sent to cli",
    });
    historyMock
      .mockReset()
      .mockResolvedValue([
        textMessage("user", "old ask", 1),
        textMessage("assistant", "old answer", 2),
      ]);
    hookHistoryMock.mockReset().mockResolvedValue([]);
    hookRunnerMock.mockReset().mockReturnValue(null);
    beforeReplyMock.mockClear();
    prepareMock.mockReset();
    restoreCliRunnerTestDeps();
    setCliRunnerTestDeps({
      claudeCliSessionTranscriptHasContent: vi.fn(async () => true),
    });
  });

  afterEach(() => {
    restoreCliRunnerTestDeps();
  });

  it("keeps valid-empty isolated completion outside the turn lifecycle", async () => {
    const hooks = createLifecycle();
    const context = buildPreparedContext(createContextEngine(hooks));
    context.params.isolatedCompletion = true;
    context.params.outputTextPolicy = "strict-visible";
    executeMock.mockResolvedValueOnce({ text: "" });
    prepareMock.mockResolvedValue(context);

    expect((await runCliAgent(context.params)).payloads).toBeUndefined();
    expect(executeMock).toHaveBeenCalledWith(context, undefined, undefined);
    expect(beforeReplyMock).not.toHaveBeenCalled();
    expect(hookRunnerMock).not.toHaveBeenCalled();
    expect(hookHistoryMock).not.toHaveBeenCalled();
    expect(historyMock).not.toHaveBeenCalled();
    for (const hook of Object.values(hooks)) {
      expect(hook).not.toHaveBeenCalled();
    }
  });

  it("runs a native control command on the existing session without turn side effects", async () => {
    const { bootstrap, afterTurn } = createLifecycle();
    const context = buildPreparedContext(createContextEngine({ bootstrap, afterTurn }));
    context.params.controlOperation = "compact";
    context.params.allowEmptyAssistantReplyAsSilent = true;
    executeMock.mockResolvedValueOnce({
      text: "",
      rawText: "",
      sessionId: "existing-external-cli-session",
    });

    prepareMock.mockResolvedValue(context);
    const result = await runCliAgent(context.params);

    expect(beforeReplyMock).not.toHaveBeenCalled();
    expect(result.meta.agentMeta?.sessionId).toBe("existing-external-cli-session");
    expect(executeMock).toHaveBeenCalledWith(context, "existing-external-cli-session", undefined);
    expect(hookRunnerMock).not.toHaveBeenCalled();
    expect(hookHistoryMock).not.toHaveBeenCalled();
    expect(historyMock).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(afterTurn).not.toHaveBeenCalled();
  });

  it("finalizes full post-bootstrap history with transcript turn text", async () => {
    const { bootstrap, afterTurn, maintain, dispose } = createLifecycle();
    const history = Array.from({ length: 101 }, (_, index) =>
      textMessage("user", `old ask ${index}`, index),
    );
    bootstrap.mockImplementation(async () => {
      historyMock.mockResolvedValueOnce(history);
      return { bootstrapped: true };
    });
    const contextEngine = createContextEngine({ bootstrap, afterTurn, maintain, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.prompt = "runtime context\n\noriginal user ask";
    delete context.params.transcriptPrompt;
    context.contextEngineTurnPrompt = "original user ask";
    const result = await runPreparedCliAgent(context);

    expect(result.meta.agentMeta?.sessionId).toBe("external-cli-session-1");
    expect(result.meta.agentMeta).toMatchObject({
      usage: { input: 21, output: 9, total: 30 },
      lastCallUsage: { input: 11, output: 7, total: 18 },
      diagnosticUsage: { input: 21, output: 9, total: 30 },
    });
    expect(historyMock).toHaveBeenCalledExactlyOnceWith(context.params);
    expect(hookHistoryMock).not.toHaveBeenCalled();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    const bootstrapParams = bootstrap.mock.calls[0]?.[0];
    expect.soft(bootstrapParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionTarget,
      sessionFile: "session.jsonl",
    });
    expect(afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect.soft(afterTurnParams).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionTarget,
      sessionFile: "session.jsonl",
      prePromptMessageCount: 101,
      isHeartbeat: false,
      tokenBudget: undefined,
      runtimeContext: undefined,
    });
    expect(afterTurnParams?.messages).toHaveLength(103);
    expect(afterTurnParams?.messages.slice(0, 101)).toEqual(history);
    expect(afterTurnParams?.messages[101]).toMatchObject({
      role: "user",
      content: "original user ask",
    });
    expect(afterTurnParams?.messages[102]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      provider: "claude-cli",
      model: "sonnet-4.6",
      usage: { input: 11, output: 7, total: 18 },
    });
    expect(maintain).toHaveBeenCalledTimes(2);
    expect.soft(maintain.mock.calls[0]?.[0]).toMatchObject({
      sessionTarget,
    });
    expect.soft(maintain.mock.calls[1]?.[0]).toMatchObject({
      sessionId: "openclaw-session-1",
      sessionKey: "agent:main:main",
      sessionTarget,
      sessionFile: "session.jsonl",
      runtimeContext: {
        rewriteTranscriptEntries: expect.any(Function),
        llm: { complete: expect.any(Function) },
      },
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each(["admission", "terminal"] as const)(
    "does not emit CLI turn facts without %s",
    async (missing) => {
      const { afterTurn, maintain, dispose } = createLifecycle();
      const context = buildPreparedContext(createContextEngine({ afterTurn, maintain, dispose }));
      const onContextEngineTurnCandidate = vi.fn();
      context.params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;
      if (missing === "terminal") {
        context.params.userTurnTranscriptRecorder = createAdmittedCliRecorder("cli-user").recorder;
        context.params.persistAssistantTranscript = false;
      }
      prepareMock.mockResolvedValue(context);

      await runCliAgent(context.params);

      expect(onContextEngineTurnCandidate).not.toHaveBeenCalled();
      expect(afterTurn).not.toHaveBeenCalled();
      expect(maintain).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    },
  );

  it.each(["messaging", "room_event"] as const)(
    "uses the admitted user anchor for transcriptless %s",
    async (kind) => {
      const context = buildPreparedContext(createContextEngine());
      const { admission, recorder } = createAdmittedCliRecorder("cli-user");
      const candidate = vi.fn();
      context.params.onContextEngineTurnCandidate = candidate;
      context.params.userTurnTranscriptRecorder = recorder;
      if (kind === "messaging") {
        executeMock.mockResolvedValue({
          text: "",
          didSendViaMessagingTool: true,
          sourceReplyDelivered: true,
        });
      } else {
        context.params.currentInboundEventKind = "room_event";
        context.params.persistAssistantTranscript = false;
      }
      await runPreparedCliAgent(context);
      expect(candidate).toHaveBeenCalledWith(
        expect.objectContaining({
          boundary: { admission, terminal: admission },
          sessionIdUsed: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
        }),
      );
    },
  );

  it("does not synthesize a context-engine user turn for empty transcript prompts", async () => {
    const { afterTurn, dispose } = createLifecycle();
    const contextEngine = createContextEngine({ afterTurn, dispose });
    const context = buildPreparedContext(contextEngine);
    context.params.transcriptPrompt = "";
    context.contextEngineTurnPrompt = "";
    await runPreparedCliAgent(context);

    const afterTurnParams = afterTurn.mock.calls[0]?.[0];
    expect(afterTurnParams?.messages).toHaveLength(3);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    expect(afterTurnParams?.messages.slice(0, 2)).toEqual([
      textMessage("user", "old ask", 1),
      textMessage("assistant", "old answer", 2),
    ]);
    const turnMessages = afterTurnParams?.messages.slice(afterTurnParams.prePromptMessageCount);
    expect(turnMessages).toHaveLength(1);
    expect(turnMessages?.[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    });
    expect(dispose).not.toHaveBeenCalled();
  });

  it("preserves deferred maintenance ownership for background engines", async () => {
    const { maintain, dispose } = createLifecycle();
    const contextEngine = createContextEngine({
      info: {
        id: "test-background-context-engine",
        name: "Test background context engine",
        turnMaintenanceMode: "background",
      },
      maintain,
      dispose,
    });
    const context = buildPreparedContext(contextEngine);

    await runPreparedCliAgent(context);

    expect(dispose).not.toHaveBeenCalled();
    await waitForDeferredTurnMaintenanceForSession(context.params.sessionKey);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not finalize or run turn maintenance on failed CLI attempts", async () => {
    executeMock.mockRejectedValue(new Error("cli boom"));
    const { bootstrap, afterTurn, maintain, dispose } = createLifecycle();
    const ingestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(async () => ({
      ingestedCount: 0,
    }));
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      ingestBatch,
      maintain,
      dispose,
      info: {
        id: "test-background-context-engine",
        name: "Background",
        turnMaintenanceMode: "background",
      },
    });
    await expect(runPreparedCliAgent(buildPreparedContext(contextEngine))).rejects.toThrow(
      "cli boom",
    );

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(afterTurn).not.toHaveBeenCalled();
    expect(ingestBatch).not.toHaveBeenCalled();
    expect(maintain).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
  });
});
