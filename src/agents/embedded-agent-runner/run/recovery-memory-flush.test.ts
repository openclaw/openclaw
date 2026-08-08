import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFlushPlan } from "../../../plugins/registry-contribution-types.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const mocks = vi.hoisted(() => ({
  resolveMemoryFlushPlan: vi.fn(),
  resolveContextTokensForModel: vi.fn(),
  resolveSandboxRuntimeStatus: vi.fn(),
  resolveSandboxConfigForAgent: vi.fn(),
  loadSessionEntry: vi.fn(),
  updateSessionEntry: vi.fn(),
  upsertSessionEntry: vi.fn(),
  deleteSessionEntryLifecycle: vi.fn(),
  readRecentSessionTranscriptActiveEvents: vi.fn(),
  runEmbeddedAgent: vi.fn(),
  recordWriteProvenance: vi.fn(),
}));

vi.mock("../../../plugins/memory-state.js", () => ({
  resolveMemoryFlushPlan: mocks.resolveMemoryFlushPlan,
}));

vi.mock("../../../agents/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../agents/context.js")>();
  return {
    ...actual,
    resolveContextTokensForModel: mocks.resolveContextTokensForModel,
  };
});

vi.mock("../../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: mocks.resolveSandboxRuntimeStatus,
  resolveSandboxConfigForAgent: mocks.resolveSandboxConfigForAgent,
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
    updateSessionEntry: mocks.updateSessionEntry,
    upsertSessionEntry: mocks.upsertSessionEntry,
    deleteSessionEntryLifecycle: mocks.deleteSessionEntryLifecycle,
    readRecentSessionTranscriptActiveEvents: mocks.readRecentSessionTranscriptActiveEvents,
  };
});

const plan: MemoryFlushPlan = {
  softThresholdTokens: 4_000,
  forceFlushTranscriptBytes: 2 * 1024 * 1024,
  reserveTokensFloor: 20_000,
  prompt: "Pre-compaction memory flush.",
  systemPrompt: "Pre-compaction memory flush turn.",
  relativePath: "memory/2026-08-03.md",
};

const runParams = {
  runId: "outer-run",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  workspaceDir: "/tmp/workspace",
  config: {},
  prompt: "continue",
  timeoutMs: 30_000,
  senderIsOwner: true,
  runRecoveryMemoryFlushTurn: mocks.runEmbeddedAgent,
} as unknown as RunEmbeddedAgentParams;

function defaultDecisionInput() {
  return {
    cfg: {},
    sessionKey: "agent:main:session-1",
    agentId: "main",
    provider: "ollama",
    modelId: "qwen2.5:14b",
    trigger: "user" as const,
    plan,
    entry: null,
    observedOverflowTokens: 30_000,
    contextTokenBudget: 32_000,
  };
}

describe("resolveRecoveryMemoryFlushDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSandboxRuntimeStatus.mockReturnValue({
      sandboxed: false,
      agentId: "main",
      sessionKey: "agent:main:session-1",
      mainSessionKey: "agent:main:main",
      mode: "host",
      toolPolicy: {},
    });
    mocks.resolveSandboxConfigForAgent.mockReturnValue({ workspaceAccess: "rw" });
    mocks.resolveContextTokensForModel.mockReturnValue(32_768);
  });

  it("skips when no memory flush plan is configured", async () => {
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      plan: null,
    });
    expect(result).toEqual({ action: "skip", reason: "no_memory_flush_plan" });
  });

  it("skips heartbeat maintenance contexts", async () => {
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      trigger: "heartbeat",
    });
    expect(result).toEqual({ action: "skip", reason: "heartbeat_turn" });
  });

  it("skips incognito sessions", async () => {
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      sessionKey: "agent:main:subagent:incognito-flush-test",
    });
    expect(result).toEqual({ action: "skip", reason: "incognito_session" });
  });

  it("skips entry-marked incognito sessions even with a normal-shaped key", async () => {
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        incognito: true,
      },
    });
    expect(result).toEqual({ action: "skip", reason: "incognito_session" });
  });

  it("skips read-only sandboxed workspaces", async () => {
    mocks.resolveSandboxRuntimeStatus.mockReturnValue({
      sandboxed: true,
      agentId: "main",
      sessionKey: "agent:main:session-1",
      mainSessionKey: "agent:main:main",
      mode: "sandbox",
      toolPolicy: {},
    });
    mocks.resolveSandboxConfigForAgent.mockReturnValue({ workspaceAccess: "ro" });
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision(defaultDecisionInput());
    expect(result).toEqual({ action: "skip", reason: "sandbox_workspace_not_writable" });
  });

  it("skips when the session already flushed for this compaction cycle", async () => {
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        compactionCount: 3,
        memoryFlush: { kind: "succeeded", compactionCount: 3 },
      },
    });
    expect(result).toEqual({ action: "skip", reason: "already_flushed_for_compaction" });
  });

  it("skips when the observed overflow cannot fit the flush model headroom", async () => {
    mocks.resolveContextTokensForModel.mockReturnValue(32_768);
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision(defaultDecisionInput());
    expect(result).toEqual({ action: "skip", reason: "maintenance_turn_not_admissible" });
  });

  it("flushes when a larger-context flush model override makes the turn admissible", async () => {
    mocks.resolveContextTokensForModel.mockReturnValue(131_072);
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      plan: { ...plan, model: "ollama/llama3.2" },
    });
    expect(result).toEqual({
      action: "flush",
      provider: "ollama",
      model: "llama3.2",
      contextWindowTokens: 131_072,
    });
    expect(mocks.resolveContextTokensForModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama", model: "llama3.2" }),
    );
  });

  it("skips when the flush model context window is unknown", async () => {
    mocks.resolveContextTokensForModel.mockReturnValue(undefined);
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      plan: { ...plan, model: "ollama/unregistered-model" },
    });
    expect(result).toEqual({ action: "skip", reason: "unknown_flush_context_window" });
  });

  it("evaluates sandbox writability against the sandbox policy key, not the transcript key", async () => {
    // Direct-message policy: sandboxSessionKey differs from transcript sessionKey.
    // The gate must evaluate sandbox writability using the policy key.
    mocks.resolveContextTokensForModel.mockReturnValue(131_072);
    mocks.resolveSandboxRuntimeStatus.mockImplementation((params: { sessionKey?: string }) => ({
      sandboxed: params.sessionKey === "agent:main:dm-user-1",
      agentId: "main",
      sessionKey: params.sessionKey,
      mainSessionKey: "agent:main:main",
      mode: params.sessionKey === "agent:main:dm-user-1" ? "sandbox" : "host",
      toolPolicy: {},
    }));
    mocks.resolveSandboxConfigForAgent.mockReturnValue({ workspaceAccess: "ro" });
    const { resolveRecoveryMemoryFlushDecision } =
      await import("./recovery-memory-flush-decision.js");
    const result = resolveRecoveryMemoryFlushDecision({
      ...defaultDecisionInput(),
      sessionKey: "agent:main:session-1",
      sandboxPolicySessionKey: "agent:main:dm-user-1",
    });
    // Read-only sandbox under the policy key → skip, even though the transcript
    // key would resolve as non-sandboxed (host/writable).
    expect(result).toEqual({ action: "skip", reason: "sandbox_workspace_not_writable" });
    expect(mocks.resolveSandboxRuntimeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:dm-user-1" }),
    );
  });
});

describe("attemptRecoveryMemoryFlush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMemoryFlushPlan.mockReturnValue(plan);
    mocks.resolveSandboxRuntimeStatus.mockReturnValue({
      sandboxed: false,
      agentId: "main",
      sessionKey: "agent:main:session-1",
      mainSessionKey: "agent:main:main",
      mode: "host",
      toolPolicy: {},
    });
    mocks.resolveContextTokensForModel.mockReturnValue(131_072);
    mocks.loadSessionEntry.mockReturnValue(undefined);
    mocks.updateSessionEntry.mockResolvedValue({});
    // Default: the nested maintenance turn writes memory (invokes the core
    // `write` tool). Tests that need a no-write or failed turn override this.
    mocks.runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      void params.onAgentEvent?.({
        stream: "tool",
        data: { name: "write", phase: "result", isError: false },
      });
      return { meta: {}, payloads: [] };
    });
  });

  it("runs a bounded silent maintenance turn and records flush state", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      compactionCount: 2,
      memoryFlush: undefined,
      sessionId: "session-1",
      updatedAt: 1,
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const messagesSnapshot = [
      {
        role: "user" as const,
        content: "DURABLE DECISION: deploy on Friday.",
        timestamp: 1,
      },
    ];
    const result = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      messagesSnapshot,
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      }),
    });
    expect(result).toEqual({ action: "flushed" });
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "memory",
        suppressCompactionRecovery: true,
        memoryFlushWritePath: "memory/2026-08-03.md",
        prompt: expect.stringContaining("DURABLE DECISION: deploy on Friday."),
        silentExpected: true,
        modelFallbacksOverride: [],
        disableTrajectory: true,
        sessionKey: expect.stringMatching(/^agent:main:flush-/u),
      }),
    );
    expect(mocks.updateSessionEntry).toHaveBeenCalledWith(
      { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      expect.any(Function),
      { skipMaintenance: true, takeCacheOwnership: true },
    );
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/store.sqlite",
        target: {
          storeKeys: [expect.stringMatching(/^agent:main:flush-/u)],
          canonicalKey: expect.stringMatching(/^agent:main:flush-/u),
        },
      }),
    );
  });

  it("clears inherited delivery/progress and logical-turn state from the nested maintenance turn", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      compactionCount: 2,
      memoryFlush: undefined,
      sessionId: "session-1",
      updatedAt: 1,
    });
    const outerOnToolResult = vi.fn();
    const outerOnPartialReply = vi.fn();
    const outerOnBlockReply = vi.fn();
    const outerOnRunProgress = vi.fn();
    const outerOnExecutionStarted = vi.fn();
    const outerShouldEmitToolResult = vi.fn(() => true);
    const outerReplyOperation = { setPhase: vi.fn(), updateSessionId: vi.fn() };
    const outerRecorder = {
      complete: vi.fn(),
      onUserMessagePersisted: vi.fn(),
    };
    const outerEnqueue = vi.fn();
    const outerLogicalTurnLease = {
      begin: vi.fn(),
      selectForHost: vi.fn(),
      degradeBeforeStart: vi.fn(),
      deferDisposalUntil: vi.fn(),
      dispose: vi.fn(),
    };
    const outerOnContextEngineTurnCandidate = vi.fn();
    const outerFastModeAutoProgressState = { offAnnounced: false, resetAnnounced: false };
    const runParamsWithDelivery = {
      ...runParams,
      fastMode: "auto" as const,
      fastModeAutoProgressState: outerFastModeAutoProgressState,
      fastModeStartedAtMs: 1_000,
      fastModeAutoOnSeconds: 30,
      onToolResult: outerOnToolResult,
      onPartialReply: outerOnPartialReply,
      onBlockReply: outerOnBlockReply,
      onRunProgress: outerOnRunProgress,
      onExecutionStarted: outerOnExecutionStarted,
      shouldEmitToolResult: outerShouldEmitToolResult,
      replyOperation: outerReplyOperation,
      userTurnTranscriptRecorder: outerRecorder,
      enqueue: outerEnqueue,
      contextEngineLogicalTurnLease: outerLogicalTurnLease,
      onContextEngineTurnCandidate: outerOnContextEngineTurnCandidate,
      streamParams: { stream: true },
      internalEvents: [{ kind: "turn_started" }],
      inputProvenance: { source: "user" },
      ownerNumbers: ["+10001"],
      sourceReplyDeliveryMode: "visible",
      taskSuggestionDeliveryMode: "visible",
      silentReplyPromptMode: "prompt",
      deferTerminalLifecycle: true,
      deferTerminalLifecycleEnd: true,
      blockReplyBreak: "text_end",
      blockReplyChunking: "full",
      streamReasoningInNonStreamModes: true,
      terminalReplyExpectation: "required",
      allowEmptyAssistantReplyAsSilent: true,
      conversationRecall: { scope: "memory" },
      cleanupBundleMcpOnRunEnd: true,
      suppressNextUserMessagePersistence: true,
      suppressTranscriptOnlyAssistantPersistence: true,
      suppressAssistantErrorPersistence: true,
    } as unknown as RunEmbeddedAgentParams;
    mocks.runEmbeddedAgent.mockImplementation(
      async (params: { onAgentEvent?: (evt: Record<string, unknown>) => void }) => {
        params.onAgentEvent?.({
          stream: "tool",
          data: { name: "write", phase: "result", isError: false },
        });
        return { meta: {}, payloads: [] };
      },
    );
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const outcome = await attemptRecoveryMemoryFlush({
      runParams: runParamsWithDelivery,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      messagesSnapshot: [
        { role: "user" as const, content: "DURABLE DECISION: deploy on Friday.", timestamp: 1 },
      ],
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      }),
    });
    expect(outcome).toEqual({ action: "flushed" });
    const nestedParams = mocks.runEmbeddedAgent.mock.calls[0]![0] as RunEmbeddedAgentParams;
    expect(nestedParams.replyOperation).toBeUndefined();
    expect(nestedParams.shouldEmitToolResult).toBeUndefined();
    expect(nestedParams.shouldEmitToolOutput).toBeUndefined();
    expect(nestedParams.onExecutionStarted).toBeUndefined();
    expect(nestedParams.onExecutionPhase).toBeUndefined();
    expect(nestedParams.onRunProgress).toBeUndefined();
    expect(nestedParams.onPartialReply).toBeUndefined();
    expect(nestedParams.onBlockReply).toBeUndefined();
    expect(nestedParams.onToolResult).toBeUndefined();
    expect(nestedParams.onAgentToolResult).toBeUndefined();
    expect(nestedParams.onUserMessagePersisted).toBeUndefined();
    expect(nestedParams.contextEngineLogicalTurnLease).toBeUndefined();
    expect(nestedParams.onContextEngineTurnCandidate).toBeUndefined();
    expect(nestedParams.userTurnTranscriptRecorder).toBeUndefined();
    expect(nestedParams.enqueue).toBeUndefined();
    expect(nestedParams.streamParams).toBeUndefined();
    expect(nestedParams.internalEvents).toBeUndefined();
    expect(nestedParams.inputProvenance).toBeUndefined();
    expect(nestedParams.ownerNumbers).toBeUndefined();
    expect(nestedParams.sourceReplyDeliveryMode).toBeUndefined();
    expect(nestedParams.taskSuggestionDeliveryMode).toBeUndefined();
    expect(nestedParams.silentReplyPromptMode).toBeUndefined();
    expect(nestedParams.deferTerminalLifecycle).toBeUndefined();
    expect(nestedParams.deferTerminalLifecycleEnd).toBeUndefined();
    expect(nestedParams.blockReplyBreak).toBeUndefined();
    expect(nestedParams.blockReplyChunking).toBeUndefined();
    expect(nestedParams.streamReasoningInNonStreamModes).toBeUndefined();
    expect(nestedParams.terminalReplyExpectation).toBeUndefined();
    expect(nestedParams.allowEmptyAssistantReplyAsSilent).toBeUndefined();
    expect(nestedParams.conversationRecall).toBeUndefined();
    expect(nestedParams.cleanupBundleMcpOnRunEnd).toBeUndefined();
    expect(nestedParams.suppressNextUserMessagePersistence).toBeUndefined();
    expect(nestedParams.suppressTranscriptOnlyAssistantPersistence).toBeUndefined();
    expect(nestedParams.suppressAssistantErrorPersistence).toBeUndefined();
    // Fast-mode shared progress state must not reach the nested turn: the
    // nested run mutates `offAnnounced`/`resetAnnounced` on whatever object it
    // receives, so inheriting the outer shared object would corrupt the resumed
    // user turn's visible fast-mode transition.
    expect(nestedParams.fastMode).toBeUndefined();
    expect(nestedParams.fastModeAutoProgressState).toBeUndefined();
    expect(nestedParams.fastModeStartedAtMs).toBeUndefined();
    expect(nestedParams.fastModeAutoOnSeconds).toBeUndefined();
    expect(outerFastModeAutoProgressState.offAnnounced).toBe(false);
    expect(outerFastModeAutoProgressState.resetAnnounced).toBe(false);
    expect(nestedParams.onAgentEvent).toBeTypeOf("function");
    // The retained private observer still detects the memory write...
    expect(mocks.updateSessionEntry).toHaveBeenCalled();
    // ...but no outer delivery/progress callback fired and the outer recorder
    // was neither supplied to the nested run nor completed.
    expect(outerOnToolResult).not.toHaveBeenCalled();
    expect(outerOnPartialReply).not.toHaveBeenCalled();
    expect(outerOnBlockReply).not.toHaveBeenCalled();
    expect(outerOnRunProgress).not.toHaveBeenCalled();
    expect(outerOnExecutionStarted).not.toHaveBeenCalled();
    expect(outerShouldEmitToolResult).not.toHaveBeenCalled();
    expect(outerRecorder.complete).not.toHaveBeenCalled();
    expect(outerEnqueue).not.toHaveBeenCalled();
    expect(outerLogicalTurnLease.begin).not.toHaveBeenCalled();
    expect(outerLogicalTurnLease.selectForHost).not.toHaveBeenCalled();
    expect(outerOnContextEngineTurnCandidate).not.toHaveBeenCalled();
  });

  it("does not mutate the outer fast-mode progress state across the nested flush turn", async () => {
    // Regression for the ClawSweeper P2: progress-controller mutates
    // `offAnnounced`/`resetAnnounced` on the shared fastModeAutoProgressState
    // object the nested turn receives. If the nested turn inherited the outer
    // object, the resumed user turn would skip its own visible fast-mode
    // transition. Prove the outer object is unchanged even when the nested run
    // touches its (own, separate) progress state.
    mocks.loadSessionEntry.mockReturnValue({
      compactionCount: 2,
      memoryFlush: undefined,
      sessionId: "session-1",
      updatedAt: 1,
    });
    const outerFastModeAutoProgressState = { offAnnounced: false, resetAnnounced: false };
    const runParamsWithFastMode = {
      ...runParams,
      fastMode: "auto" as const,
      fastModeAutoProgressState: outerFastModeAutoProgressState,
      fastModeStartedAtMs: 1_000,
      fastModeAutoOnSeconds: 30,
    } as unknown as RunEmbeddedAgentParams;
    // Simulate the nested run's progress-controller mutating whatever
    // fastModeAutoProgressState it received — exactly the corruption path.
    mocks.runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const state = params.fastModeAutoProgressState;
      if (state && typeof state === "object" && "offAnnounced" in state) {
        (state as { offAnnounced: boolean }).offAnnounced = true;
        (state as { resetAnnounced?: boolean }).resetAnnounced = true;
      }
      // The turn still writes memory so it counts as a successful checkpoint;
      // the regression below is about the outer object, not the write path.
      void params.onAgentEvent?.({
        stream: "tool",
        data: { name: "write", phase: "result", isError: false },
      });
      return { meta: {}, payloads: [] };
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const outcome = await attemptRecoveryMemoryFlush({
      runParams: runParamsWithFastMode,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      messagesSnapshot: [
        { role: "user" as const, content: "DURABLE DECISION: deploy on Friday.", timestamp: 1 },
      ],
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      }),
    });
    expect(outcome).toEqual({ action: "flushed" });
    // The nested run received no shared outer object, so its mutation (if any)
    // could not have touched the outer state.
    expect(outerFastModeAutoProgressState.offAnnounced).toBe(false);
    expect(outerFastModeAutoProgressState.resetAnnounced).toBe(false);
    const nestedParams = mocks.runEmbeddedAgent.mock.calls[0]![0] as RunEmbeddedAgentParams;
    expect(nestedParams.fastModeAutoProgressState).toBeUndefined();
  });

  it("strips client-hosted tools from the nested flush turn so a delegated terminal result cannot stamp flush success", async () => {
    // Regression for the ClawSweeper P1: the outer spread used to retain
    // clientTools, which bypass the core memory-flush tool filter and can
    // return a delegated terminal result. That result is not a failed
    // maintenance turn, so the active session would be marked
    // memoryFlush: succeeded even though no memory was written, suppressing
    // another checkpoint before compaction. Prove clientTools (and the
    // related outer initiator tool/authority surface) never reach the nested
    // run, and that a turn which completes without a memory write is not
    // stamped as a successful flush.
    mocks.loadSessionEntry.mockReturnValue({
      compactionCount: 2,
      memoryFlush: undefined,
      sessionId: "session-1",
      updatedAt: 1,
    });
    const clientTool = { name: "client_probe", description: "client-hosted probe" };
    const runParamsWithClientTools = {
      ...runParams,
      clientTools: [clientTool],
      clientCaps: ["custom-cap"],
      toolBindings: { foo: "bar" },
      runtimePluginToolGrant: { granted: true },
      scheduledToolPolicy: { capped: true },
    } as unknown as RunEmbeddedAgentParams;
    // Simulate a delegated client-tool terminal result: the nested run ends
    // without ever invoking the core `write` tool, so memoryFlushWroteTarget
    // stays false.
    mocks.runEmbeddedAgent.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      // The nested turn must not see any outer client/plugin tool surface.
      expect(params.clientTools).toBeUndefined();
      expect(params.clientCaps).toBeUndefined();
      expect(params.toolBindings).toBeUndefined();
      expect(params.runtimePluginToolGrant).toBeUndefined();
      expect(params.scheduledToolPolicy).toBeUndefined();
      return { meta: {}, payloads: [] };
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const outcome = await attemptRecoveryMemoryFlush({
      runParams: runParamsWithClientTools,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      messagesSnapshot: [
        { role: "user" as const, content: "DURABLE DECISION: deploy on Friday.", timestamp: 1 },
      ],
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      }),
    });
    // No memory was written, so the checkpoint must be skipped — NOT stamped
    // as a successful flush that suppresses another checkpoint this cycle.
    expect(outcome).toEqual({ action: "skipped", reason: "no_memory_written" });
  });

  it("keeps the ephemeral flush run in the active custom store", async () => {
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const result = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: {
          storePath: "/tmp/custom-store.sqlite",
          sessionKey: "agent:main:session-1",
        },
      }),
    });
    expect(result).toEqual({ action: "flushed" });
    const nestedRunCall = mocks.runEmbeddedAgent.mock.calls[0]?.[0] as RunEmbeddedAgentParams;
    // The nested flush must resolve the same store where the ephemeral entry is
    // pre-created and later cleaned up, never the default store.
    expect(nestedRunCall.sessionTarget).toEqual({
      agentId: "main",
      sessionId: nestedRunCall.sessionId,
      sessionKey: nestedRunCall.sessionKey,
      storePath: "/tmp/custom-store.sqlite",
    });
    expect(nestedRunCall.sessionManager).toBeUndefined();
    expect(mocks.upsertSessionEntry).toHaveBeenCalledWith(
      {
        storePath: "/tmp/custom-store.sqlite",
        sessionKey: nestedRunCall.sessionKey,
        agentId: "main",
      },
      { sessionId: nestedRunCall.sessionId },
    );
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/custom-store.sqlite",
        target: {
          storeKeys: [nestedRunCall.sessionKey],
          canonicalKey: nestedRunCall.sessionKey,
        },
      }),
    );
  });

  it("cleans up the ephemeral flush session from the active custom store on a failed turn", async () => {
    mocks.runEmbeddedAgent.mockResolvedValue({
      meta: {},
      payloads: [{ text: "maintenance failed", isError: true }],
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const result = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: {
          storePath: "/tmp/custom-store.sqlite",
          sessionKey: "agent:main:session-1",
        },
      }),
    });
    expect(result).toEqual({ action: "skipped", reason: "maintenance_turn_failed" });
    const nestedRunCall = mocks.runEmbeddedAgent.mock.calls[0]?.[0] as RunEmbeddedAgentParams;
    expect(nestedRunCall.sessionTarget).toEqual({
      agentId: "main",
      sessionId: nestedRunCall.sessionId,
      sessionKey: nestedRunCall.sessionKey,
      storePath: "/tmp/custom-store.sqlite",
    });
    expect(mocks.updateSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/custom-store.sqlite",
        target: {
          storeKeys: [nestedRunCall.sessionKey],
          canonicalKey: nestedRunCall.sessionKey,
        },
      }),
    );
  });

  it("keeps the ephemeral flush run in the active store for a target-only identity", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      compactionCount: 2,
      memoryFlush: undefined,
      sessionId: "session-1",
      updatedAt: 1,
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    // Target-only identity: the runner derives the resolved session key from
    // the active session target while the raw runParams key is absent. The
    // resolved key must still scope the ephemeral flush entry and its cleanup
    // to the active store instead of the default store.
    const targetOnlyRunParams = {
      ...runParams,
      sessionKey: undefined,
    } as RunEmbeddedAgentParams;
    const result = await attemptRecoveryMemoryFlush({
      runParams: targetOnlyRunParams,
      sessionKey: "agent:main:session-1",
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: {
          storePath: "/tmp/custom-store.sqlite",
          sessionKey: "agent:main:session-1",
        },
      }),
    });
    expect(result).toEqual({ action: "flushed" });
    const nestedRunCall = mocks.runEmbeddedAgent.mock.calls[0]?.[0] as RunEmbeddedAgentParams;
    expect(nestedRunCall.sessionTarget).toEqual({
      agentId: "main",
      sessionId: nestedRunCall.sessionId,
      sessionKey: nestedRunCall.sessionKey,
      storePath: "/tmp/custom-store.sqlite",
    });
    expect(mocks.upsertSessionEntry).toHaveBeenCalledWith(
      {
        storePath: "/tmp/custom-store.sqlite",
        sessionKey: nestedRunCall.sessionKey,
        agentId: "main",
      },
      { sessionId: nestedRunCall.sessionId },
    );
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/tmp/custom-store.sqlite",
        target: {
          storeKeys: [nestedRunCall.sessionKey],
          canonicalKey: nestedRunCall.sessionKey,
        },
      }),
    );
    expect(mocks.updateSessionEntry).toHaveBeenCalledWith(
      { storePath: "/tmp/custom-store.sqlite", sessionKey: "agent:main:session-1" },
      expect.any(Function),
      { skipMaintenance: true, takeCacheOwnership: true },
    );
  });

  it("skips without running a turn when no flush plan is configured", async () => {
    mocks.resolveMemoryFlushPlan.mockReturnValue(null);
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const result = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({ id: "session-1" }),
    });
    expect(result).toEqual({ action: "skipped", reason: "no_memory_flush_plan" });
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(mocks.updateSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteSessionEntryLifecycle).not.toHaveBeenCalled();
  });

  it("skips with a visible reason when no flush executor is injected", async () => {
    mocks.resolveMemoryFlushPlan.mockReturnValue(plan);
    mocks.upsertSessionEntry.mockResolvedValue(null);
    const noSideEffectWorkspace = "/tmp/workspace-noexec";
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const result = await attemptRecoveryMemoryFlush({
      runParams: {
        ...runParams,
        workspaceDir: noSideEffectWorkspace,
        runRecoveryMemoryFlushTurn: undefined,
      },
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({ id: "session-1" }),
    });
    expect(result).toEqual({
      action: "skipped",
      reason: "recovery_flush_executor_unavailable",
    });
    expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(mocks.upsertSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteSessionEntryLifecycle).not.toHaveBeenCalled();
    expect(fs.existsSync(`${noSideEffectWorkspace}/memory/2026-08-03.md`)).toBe(false);
  });

  it("treats an error-payload maintenance turn as a bounded skip", async () => {
    mocks.runEmbeddedAgent.mockResolvedValue({
      meta: {},
      payloads: [{ text: "maintenance failed", isError: true }],
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const result = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({ id: "session-1" }),
    });
    expect(result).toEqual({ action: "skipped", reason: "maintenance_turn_failed" });
    expect(mocks.updateSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalled();
  });

  it.each([
    { name: "aborted", result: { meta: { aborted: true }, payloads: [] } },
    {
      name: "errored metadata",
      result: {
        meta: { error: { kind: "incomplete_turn", message: "turn failed" } },
        payloads: [],
      },
    },
    { name: "timeout stop reason", result: { meta: { stopReason: "timeout" }, payloads: [] } },
    {
      name: "timeout phase",
      result: { meta: { timeoutPhase: "provider" }, payloads: [] },
    },
    { name: "error stop reason", result: { meta: { stopReason: "error" }, payloads: [] } },
  ])("treats a maintenance turn with $name metadata as a bounded skip", async ({ result }) => {
    mocks.runEmbeddedAgent.mockResolvedValue(result);
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const outcome = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({ id: "session-1" }),
    });
    expect(outcome).toEqual({ action: "skipped", reason: "maintenance_turn_failed" });
    expect(mocks.updateSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalled();
  });

  it("treats a throwing maintenance turn as a bounded skip", async () => {
    mocks.runEmbeddedAgent.mockRejectedValue(new Error("provider unreachable"));
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    const result = await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({ id: "session-1" }),
    });
    expect(result).toEqual({ action: "skipped", reason: "maintenance_turn_failed" });
    expect(mocks.updateSessionEntry).not.toHaveBeenCalled();
    expect(mocks.deleteSessionEntryLifecycle).toHaveBeenCalled();
  });

  it("records write provenance when the maintenance turn writes the memory target", async () => {
    mocks.resolveMemoryFlushPlan.mockReturnValue({
      ...plan,
      recordWriteProvenance: mocks.recordWriteProvenance,
    });
    mocks.recordWriteProvenance.mockResolvedValue(undefined);
    mocks.readRecentSessionTranscriptActiveEvents.mockReturnValue([
      { message: { role: "user", content: "hi", timestamp: 1 } },
    ]);
    mocks.runEmbeddedAgent.mockImplementation(
      async (params: { onAgentEvent?: (evt: Record<string, unknown>) => void }) => {
        params.onAgentEvent?.({
          stream: "tool",
          data: { name: "write", phase: "result", isError: false },
        });
        return { meta: {}, payloads: [] };
      },
    );
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      messagesSnapshot: [
        {
          role: "user" as const,
          content: "DURABLE DECISION: deploy on Friday.",
          timestamp: 1,
        },
      ],
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      }),
    });
    expect(mocks.recordWriteProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace",
        relativePath: "memory/2026-08-03.md",
        contentBefore: "",
        originClass: "agent",
      }),
    );
  });

  it("runs the nested maintenance turn on a distinct lane to avoid self-deadlock", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      compactionCount: 2,
      memoryFlush: undefined,
      sessionId: "session-1",
      updatedAt: 1,
    });
    const { attemptRecoveryMemoryFlush } = await import("./recovery-memory-flush.js");
    await attemptRecoveryMemoryFlush({
      runParams,
      sessionKey: runParams.sessionKey,
      agentId: "main",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      observedOverflowTokens: 30_000,
      contextTokenBudget: 32_000,
      abortSignal: undefined,
      getActiveSession: () => ({
        id: "session-1",
        target: { storePath: "/tmp/store.sqlite", sessionKey: "agent:main:session-1" },
      }),
    });
    // The nested run must NOT inherit the outer main lane (which recovery
    // already holds); it must run on the dedicated nested lane.
    expect(mocks.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "nested" }),
    );
  });
});
