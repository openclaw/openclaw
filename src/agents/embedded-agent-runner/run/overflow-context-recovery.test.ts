import { describe, expect, it, vi } from "vitest";
import { recoverEmbeddedRunOverflow } from "./overflow-context-recovery.js";

describe("recoverEmbeddedRunOverflow", () => {
  it("queues terminal tool-loop overflow resets with the resolved durable session key", async () => {
    const deferredReset = vi.fn();
    const compact = vi.fn();
    const promptError = new Error(
      "request_too_large: estimated context size exceeds safe threshold during tool loop",
    );

    const result = await recoverEmbeddedRunOverflow({
      runParams: {
        runId: "run-1",
        sessionId: "target-session",
        sessionKey: undefined,
        sessionTarget: {
          agentId: "main",
          sessionId: "target-session",
          sessionKey: "main",
          storePath: "/tmp/openclaw-sessions.json",
        },
        config: {},
        modelSelectionLocked: false,
      } as never,
      state: {
        overflowCompactionAttempts: 3,
        toolResultTruncationAttempted: false,
        autoCompactionCount: 0,
      } as never,
      contextEngine: { compact, info: {} } as never,
      contextTokenBudget: 200_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt: {
        promptErrorSource: "prompt",
        messagesSnapshot: [],
      } as never,
      attemptCompactionCount: 0,
      runtimeAuthPlan: {} as never,
      resolvedSessionKey: "main",
      sessionAgentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "openai",
      modelId: "gpt-5.6",
      harnessRuntime: "openclaw",
      thinkLevel: "high",
      authProfileIdSource: "auto",
      deferEmbeddedHookSessionReset: deferredReset,
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}) as never,
      onCompactionHookMessages: async () => undefined,
      runOwnsCompactionBeforeHook: async () => undefined,
      runOwnsCompactionAfterHook: async () => undefined,
      adoptCompactionTranscript: async () => undefined,
      getActiveSession: () => ({
        id: "target-session",
        file: "/tmp/openclaw-target-session.jsonl",
        target: {
          agentId: "main",
          sessionId: "target-session",
          sessionKey: "main",
          storePath: "/tmp/openclaw-sessions.json",
        },
      }),
      prepareCurrentTranscriptRetry: () => undefined,
      prepareCompactedTranscriptRetry: async () => undefined,
      armPostCompactionGuard: () => undefined,
    });

    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(compact).not.toHaveBeenCalled();
    expect(deferredReset).toHaveBeenCalledWith({
      key: "main",
      agentId: "main",
      reason: "new",
      commandSource: "embedded-agent:tool-loop-overflow-recovery",
    });
  });

  it("does not queue terminal tool-loop overflow resets with only a temporary session id", async () => {
    const deferredReset = vi.fn();
    const compact = vi.fn();
    const promptError = new Error(
      "request_too_large: estimated context size exceeds safe threshold during tool loop",
    );

    const result = await recoverEmbeddedRunOverflow({
      runParams: {
        runId: "run-1",
        sessionId: "target-session",
        sessionKey: undefined,
        sessionTarget: undefined,
        config: {},
        modelSelectionLocked: false,
      } as never,
      state: {
        overflowCompactionAttempts: 3,
        toolResultTruncationAttempted: false,
        autoCompactionCount: 0,
      } as never,
      contextEngine: { compact, info: {} } as never,
      contextTokenBudget: 200_000,
      genericCompactionRecoveryAllowed: true,
      aborted: false,
      signalOwnedInterruption: false,
      promptError,
      attempt: {
        promptErrorSource: "prompt",
        messagesSnapshot: [],
      } as never,
      attemptCompactionCount: 0,
      runtimeAuthPlan: {} as never,
      resolvedSessionKey: "target-session",
      sessionAgentId: "main",
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "openai",
      modelId: "gpt-5.6",
      harnessRuntime: "openclaw",
      thinkLevel: "high",
      authProfileIdSource: "auto",
      deferEmbeddedHookSessionReset: deferredReset,
      resolveContextEnginePluginId: () => undefined,
      buildRuntimeSettings: () => ({}) as never,
      onCompactionHookMessages: async () => undefined,
      runOwnsCompactionBeforeHook: async () => undefined,
      runOwnsCompactionAfterHook: async () => undefined,
      adoptCompactionTranscript: async () => undefined,
      getActiveSession: () => ({
        id: "target-session",
        file: "/tmp/openclaw-target-session.jsonl",
      }),
      prepareCurrentTranscriptRetry: () => undefined,
      prepareCompactedTranscriptRetry: async () => undefined,
      armPostCompactionGuard: () => undefined,
    });

    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(compact).not.toHaveBeenCalled();
    expect(deferredReset).not.toHaveBeenCalled();
  });
});
