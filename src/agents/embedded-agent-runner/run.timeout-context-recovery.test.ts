import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import { testing as deliveryTesting } from "../subagents/announce/subagent-announce-delivery.test-support.js";
import { sendSubagentAnnounceDirectly } from "../subagents/announce/subagent-announce-direct-delivery.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { recoverEmbeddedRunTimeout } from "./run/timeout-context-recovery.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  resolveEmbeddedRunAbandonment,
  markActiveEmbeddedRunAbandoned,
  markEmbeddedRunRecoveringTimeout,
  restoreEmbeddedRunTimeoutAbandonment,
  setActiveEmbeddedRun,
} from "./runs.js";
import { createEmbeddedRunHandle, testing as runsTesting } from "./runs.test-support.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const mocks = vi.hoisted(() => ({ compact: vi.fn(), postCompactionSideEffects: vi.fn() }));
vi.mock("./compaction-hooks.js", () => ({
  runPostCompactionSideEffects: mocks.postCompactionSideEffects,
}));
vi.mock("./logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

type RecoveryInput = Parameters<typeof recoverEmbeddedRunTimeout>[0];
const successfulCompaction = (sessionId?: string) =>
  makeCompactionSuccess({
    summary: "timeout recovery",
    tokensBefore: 150_000,
    tokensAfter: 80_000,
    sessionId,
  });

function makeInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const input: RecoveryInput = {
    runParams: {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 1_000,
      onAutoCompactionSucceeded: vi.fn(),
    },
    state: createEmbeddedRunContextRecoveryState(),
    assertRecoveryActive: vi.fn(),
    // Admission and writer fencing have composed coverage in run.compaction-runtime.test.ts.
    prepareRecoveryOwner: () => {
      const assertActive = () => {
        input.runParams.abortSignal?.throwIfAborted();
        input.assertRecoveryActive();
      };
      assertActive();
      const session = input.getActiveSession();
      return {
        session: {
          ...session,
          target: {
            agentId: input.sessionAgentId,
            sessionId: session.id,
            sessionKey: input.resolvedSessionKey,
            storePath: "/tmp/workspace/openclaw-agent.sqlite",
          },
        },
        assertActive,
        withTranscriptWrites: async <T>(signal: AbortSignal | undefined, run: () => Promise<T>) => {
          signal?.throwIfAborted();
          assertActive();
          return await run();
        },
      };
    },
    prepareRecoverySession: async () => ({
      sessionManager: undefined,
      assertActive: vi.fn<() => void>(),
      withSessionManagerRewriteLock: async <T>(operation: () => Promise<T> | T) =>
        await operation(),
    }),
    contextEngine: {
      info: { id: "legacy", name: "Legacy" },
      ingest: vi.fn(),
      assemble: vi.fn(),
      compact: mocks.compact,
    },
    contextTokenBudget: 200_000,
    genericCompactionRecoveryAllowed: true,
    timedOut: true,
    signalOwnedInterruption: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    lastRunPromptUsage: { input: 150_000, total: 150_000 },
    attempt: makeAttemptResult({
      terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
      sessionIdUsed: "session-1",
      assistantTexts: [],
      messagesSnapshot: [],
    }),
    runtimeAuthPlan: { providerForAuth: "openai", authProfileProviderForAuth: "openai" },
    resolvedSessionKey: "agent:main:session-1",
    sessionAgentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    modelSelection: { provider: "openai", model: "gpt-5.6-luna", authProfileIdSource: "auto" },
    harnessRuntime: "openclaw",
    thinkLevel: "off",
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: ({ tokenBudget, degradedReason }) =>
      buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: input.modelSelection.provider,
        requestedModel: input.modelSelection.model,
        resolvedModel: input.modelSelection.model,
        promptTokenBudget: tokenBudget,
        degradedReason,
      }),
    onCompactionHookMessages: vi.fn(async () => {}),
    runOwnsCompactionBeforeHook: vi.fn(async () => {}),
    runOwnsCompactionAfterHook: vi.fn(async () => {}),
    adoptCompactionTranscript: vi.fn(async () => undefined),
    getActiveSession: () => ({ id: "session-1", file: "/tmp/session-1.jsonl" }),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
    ...overrides,
  };
  return input;
}

describe("timeout recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compact.mockReset().mockResolvedValue(successfulCompaction());
    runsTesting.resetActiveEmbeddedRuns();
  });
  afterEach(() => {
    deliveryTesting.setDepsForTest();
    runsTesting.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("uses current context pressure at the 65 percent threshold, not aggregate billing", async () => {
    const input = makeInput({
      lastRunPromptUsage: {
        input: 20_000,
        cacheRead: 150_000,
        total: 190_000,
        contextUsage: { state: "available", promptTokens: 130_000, totalTokens: 130_500 },
      },
    });
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "session-1", tokensAfter: 80_000 },
    { sessionId: "unaccepted-successor", tokensAfter: undefined },
  ])(
    "does not attribute $sessionId tokens to the predecessor when acceptance is cancelled",
    async ({ sessionId, tokensAfter }) => {
      const controller = new AbortController();
      const callerError = new Error("caller cancelled successor acceptance");
      mocks.compact.mockResolvedValueOnce(successfulCompaction(sessionId));
      const input = makeInput({
        assertRecoveryActive: () => controller.signal.throwIfAborted(),
        adoptCompactionTranscript: vi.fn(async () => {
          controller.abort(callerError);
          throw callerError;
        }),
      });
      input.runParams.abortSignal = controller.signal;
      await expect(recoverEmbeddedRunTimeout(input)).rejects.toBe(callerError);
      expect(input.state.autoCompactionCount).toBe(1);
      expect(input.state.lastCompactionTokensAfter).toBe(tokensAfter);
      expect(mocks.postCompactionSideEffects).not.toHaveBeenCalled();
      expect(input.prepareCompactedTranscriptRetry).not.toHaveBeenCalled();
    },
  );

  it("counts thrown and empty compactions against the shared retry cap", async () => {
    const input = makeInput();
    mocks.compact
      .mockRejectedValueOnce(new Error("engine crashed"))
      .mockResolvedValue({ ok: false, compacted: false, reason: "nothing to compact" });
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(input.state.timeoutCompactionAttempts).toBe(1);
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "timeout recovery",
      expect.objectContaining({ compacted: false, reason: "Error: engine crashed" }),
      undefined,
    );
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(input.state.timeoutCompactionAttempts).toBe(2);
    expect(mocks.compact).toHaveBeenCalledTimes(2);
  });

  it("restores terminal abandonment when the recovery after-hook fails", async () => {
    const handle = createEmbeddedRunHandle({ runId: "run-1" });
    setActiveEmbeddedRun("session-1", handle, "agent:main:session-1");
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-1",
        handle,
        sessionKey: "agent:main:session-1",
        reason: "timeout",
      }),
    ).toBe(true);
    const input = makeInput({
      runOwnsCompactionAfterHook: vi.fn(async () => {
        throw new Error("after-hook failed");
      }),
    });
    await expect(recoverEmbeddedRunTimeout(input)).rejects.toThrow("after-hook failed");
    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-1" })).toBe("timeout");
  });

  it.each(["durable", "detached"] as const)(
    "keeps %s accounting separate from durable side effects",
    async (sessionPersistence) => {
      const input = makeInput({
        getActiveSession: () => ({ id: "rotated", file: "/tmp/rotated.jsonl" }),
      });
      input.contextEngine.info.ownsCompaction = true;
      input.runParams.sessionPersistence = sessionPersistence;
      expect(await recoverEmbeddedRunTimeout(input)).toBe(true);
      expect(input.state.autoCompactionCount).toBe(1);
      expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
      if (sessionPersistence === "detached") {
        expect(mocks.postCompactionSideEffects).not.toHaveBeenCalled();
      } else {
        expect(mocks.postCompactionSideEffects).toHaveBeenCalledWith({
          config: {},
          sessionKey: "agent:main:session-1",
          sessionId: "rotated",
          agentId: "main",
          sessionFile: "/tmp/rotated.jsonl",
          assertActive: input.assertRecoveryActive,
        });
      }
    },
  );

  it("defers completion during recovery, delivers to the successor, and restores terminal suppression", async () => {
    const sessionId = "session-timeout-delivery";
    const sessionKey = "agent:main:timeout-delivery";
    const sendCompletion = () =>
      sendSubagentAnnounceDirectly({
        requesterSessionKey: sessionKey,
        targetRequesterSessionKey: sessionKey,
        triggerMessage: "child completed",
        expectsCompletionMessage: true,
        requesterIsSubagent: true,
        directIdempotencyKey: "timeout-recovery-completion",
      });
    const abandon = (runId: string) => {
      const handle = createEmbeddedRunHandle({ runId });
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      expect(
        markActiveEmbeddedRunAbandoned({ sessionId, handle, sessionKey, reason: "timeout" }),
      ).toBe(true);
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      const marker = markEmbeddedRunRecoveringTimeout({ sessionId, runId });
      expect(marker).toBeDefined();
      return marker!;
    };
    const dispatchGatewayMethodInProcess = vi.fn();
    deliveryTesting.setDepsForTest({
      dispatchGatewayMethodInProcess,
      getRuntimeConfig: () => ({}),
      getRequesterSessionActivity: () => ({
        sessionId,
        isActive: isEmbeddedAgentRunActive(sessionId),
      }),
      loadRequesterSessionEntry: (requestedKey) => ({
        cfg: {},
        entry: undefined,
        canonicalKey: requestedKey,
        agentId: "main",
      }),
    });
    abandon("run-timeout");
    await expect(sendCompletion()).resolves.toMatchObject({
      delivered: false,
      path: "none",
      reason: "completion_handoff_pending",
      disposition: "retryable",
    });
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    const queueMessage = vi.fn(async () => undefined);
    const successor = createEmbeddedRunHandle({
      runId: "run-successor",
      queueMessage,
      supportsTranscriptCommitWait: true,
    });
    setActiveEmbeddedRun(sessionId, successor, sessionKey);
    await expect(sendCompletion()).resolves.toMatchObject({ delivered: true, path: "steered" });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    clearActiveEmbeddedRun(sessionId, successor, sessionKey);
    expect(restoreEmbeddedRunTimeoutAbandonment(abandon("run-terminal"))).toBe(true);
    await expect(sendCompletion()).resolves.toMatchObject({
      delivered: false,
      path: "none",
      reason: "requester_abandoned",
    });
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
  });
});
