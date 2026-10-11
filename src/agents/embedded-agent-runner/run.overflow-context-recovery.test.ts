import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { AssistantMessage } from "../../llm/types.js";
import { buildAssistantFailoverSignal } from "../embedded-agent-helpers/assistant-message-failures.js";
import { classifyFailoverSignal } from "../failover/classify.js";
import { agentSessionAutomaticCompaction } from "../sessions/agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createCompactionRequestBudget } from "../sessions/compaction/request-budget.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { prepareEmbeddedAttemptPromptPreflight } from "./run/attempt-prompt-preflight.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { recoverEmbeddedRunOverflow } from "./run/overflow-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "./session-prompt-state.js";
import { createUsageAccumulator } from "./usage-accumulator.js";

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  debug: vi.fn(),
  getProviderPromptState: vi.fn(),
  info: vi.fn(),
  isDebugEnabled: vi.fn(() => true),
  isNoRealConversationCompactionNoop: vi.fn(() => false),
  maintenance: vi.fn(),
  markProviderPromptRejected: vi.fn(),
  resetNoRealConversationTokenSnapshot: vi.fn(),
  sessionLikelyHasOversizedToolResults: vi.fn(() => false),
  truncateOversizedToolResults: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./context-engine-maintenance.js", () => ({
  runContextEngineMaintenance: mocks.maintenance,
}));

vi.mock("./logger.js", () => ({
  log: {
    debug: mocks.debug,
    info: mocks.info,
    isEnabled: mocks.isDebugEnabled,
    warn: mocks.warn,
  },
}));

vi.mock("./provider-prompt-state.js", () => ({
  getProviderPromptState: mocks.getProviderPromptState,
  markLastProviderPromptContextRejected: mocks.markProviderPromptRejected,
}));

vi.mock("./tool-result-truncation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tool-result-truncation.js")>()),
  resolveLiveToolResultMaxChars: () => 32_000,
  restoreCacheTtlToolResultProjections: vi.fn(),
  sessionLikelyHasOversizedToolResults: mocks.sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSessionManager: mocks.truncateOversizedToolResults,
}));

vi.mock("./run/session-bootstrap.js", async () => {
  const { buildContextEngineCompactionSessionTarget } = await vi.importActual<
    typeof import("./run/session-bootstrap.js")
  >("./run/session-bootstrap.js");
  return {
    buildContextEngineCompactionSessionTarget,
    isNoRealConversationCompactionNoop: mocks.isNoRealConversationCompactionNoop,
    resetNoRealConversationTokenSnapshot: mocks.resetNoRealConversationTokenSnapshot,
  };
});

type RecoveryInput = Parameters<typeof recoverEmbeddedRunOverflow>[0];
type RecoveryInputOverrides = Omit<
  Partial<RecoveryInput>,
  "attempt" | "assistantOverflowCandidate"
> & {
  attempt?: Partial<EmbeddedRunAttemptResult>;
  assistantOverflowCandidate?: AssistantMessage;
};
type CompactionResult = Awaited<ReturnType<RecoveryInput["contextEngine"]["compact"]>>;

const overflowError = () => new Error("request_too_large: Request size exceeds context window");

const successfulCompaction = (): CompactionResult =>
  ({
    ok: true,
    compacted: true,
    result: {
      summary: "Compacted session",
      tokensBefore: 150_000,
      tokensAfter: 80_000,
    },
  }) as CompactionResult;

function makeAssistantMessage(
  input: Pick<AssistantMessage, "stopReason"> &
    Partial<Pick<AssistantMessage, "errorMessage" | "usage">>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: input.usage ?? { ...createZeroUsageFixture(), input: 1, totalTokens: 1 },
    stopReason: input.stopReason,
    errorMessage: input.errorMessage,
    timestamp: 1,
  };
}

function makeInput(overrides: RecoveryInputOverrides = {}): RecoveryInput {
  const { assistantOverflowCandidate, ...restOverrides } = overrides;
  const promptError = Object.hasOwn(overrides, "promptError")
    ? overrides.promptError
    : overflowError();
  const attempt = makeAttemptResult({
    terminal: promptError
      ? { kind: "failed", source: "prompt", error: promptError }
      : { kind: "ok" },
    sessionIdUsed: "session-1",
    assistantTexts: [],
    messagesSnapshot: [],
    replayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
    ...overrides.attempt,
  });

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
    // This leaf doubles orchestration; real admission and writer fencing have composed coverage.
    prepareRecoveryOwner: () => {
      const assertActive = composeSessionSourceAssertion([
        () => {
          input.runParams.abortSignal?.throwIfAborted();
          input.assertRecoveryActive();
        },
      ]);
      assertActive();
      const session = input.getActiveSession();
      return {
        session: {
          ...session,
          target: {
            ...session.target,
            agentId: session.target?.agentId ?? input.sessionAgentId,
            sessionId: session.id,
            sessionKey: session.target?.sessionKey ?? input.resolvedSessionKey,
            storePath:
              session.target?.storePath ?? path.join(input.workspaceDir, "openclaw-agent.sqlite"),
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
      sessionManager: SessionManager.inMemory("/tmp/workspace"),
      assertActive: composeSessionSourceAssertion([]),
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
    aborted: false,
    signalOwnedInterruption: false,
    promptError,
    assistantOverflowCandidate: assistantOverflowCandidate
      ? {
          message: assistantOverflowCandidate,
          classification:
            assistantOverflowCandidate.stopReason === "error"
              ? classifyFailoverSignal(buildAssistantFailoverSignal(assistantOverflowCandidate), {
                  providerPlugin: null,
                })
              : null,
        }
      : undefined,
    attemptCompactionCount: 0,
    runtimeAuthPlan: {
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
    },
    resolvedSessionKey: "agent:main:session-1",
    sessionAgentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    modelSelection: { provider: "openai", model: "gpt-5.6-luna", authProfileIdSource: "auto" },
    harnessRuntime: "embedded",
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
    prepareCurrentTranscriptRetry: vi.fn(),
    prepareCompactedTranscriptRetry: vi.fn(async () => {}),
    markOwnedTranscriptRetry: vi.fn(),
    armPostCompactionGuard: vi.fn(),
    usageAccumulator: createUsageAccumulator(),
    ...restOverrides,
    attempt,
  };
  return input;
}

describe("recoverEmbeddedRunOverflow", () => {
  registerAgentSessionLoopTestLifecycle();
  afterEach(() => clearEmbeddedSessionPromptStates(["session-1", "rotated-session"]));
  beforeEach(() => {
    mocks.compact.mockReset().mockResolvedValue(successfulCompaction());
    mocks.debug.mockReset();
    mocks.getProviderPromptState.mockReset();
    mocks.info.mockReset();
    mocks.isDebugEnabled.mockReset().mockReturnValue(true);
    mocks.isNoRealConversationCompactionNoop.mockReset().mockReturnValue(false);
    mocks.maintenance.mockReset();
    mocks.markProviderPromptRejected.mockReset();
    mocks.resetNoRealConversationTokenSnapshot.mockReset();
    mocks.sessionLikelyHasOversizedToolResults.mockReset().mockReturnValue(false);
    mocks.truncateOversizedToolResults.mockReset().mockReturnValue({
      truncated: false,
      truncatedCount: 0,
      reason: "nothing to truncate",
    });
    mocks.warn.mockReset();
  });

  it("uses the canonical assistant classifier when the text heuristic misses", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model",
    });
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: null, assistantOverflowCandidate }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  });

  it("does not compact a validation rejection naming context_length_exceeded", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "500 Unsupported parameter: context_length_exceeded",
    });
    assistantOverflowCandidate.errorType = "invalid_request_error";
    assistantOverflowCandidate.errorCode = "unknown_parameter";
    const input = makeInput({
      promptError: null,
      assistantOverflowCandidate,
      assistantErrorText: assistantOverflowCandidate.errorMessage,
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.markProviderPromptRejected).not.toHaveBeenCalled();
    expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
  });

  it.each([{ name: "refusal alone", promptError: null, action: "none" }])(
    "preserves a structured refusal alongside $name",
    async ({ promptError, action }) => {
      const assistant = makeAssistantMessage({
        stopReason: "error",
        errorMessage: "Anthropic refusal: prompt is too long.",
      });
      assistant.diagnostics = [{ type: "provider_refusal", timestamp: 1 }];
      const input = makeInput({
        promptError,
        assistantOverflowCandidate: assistant,
        assistantErrorText: assistant.errorMessage,
      });

      expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action });
      expect(mocks.compact).toHaveBeenCalledTimes(action === "retry" ? 1 : 0);
      expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
    },
  );

  it("recovers a canonical zero-output length overflow", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "length",
      usage: { ...createZeroUsageFixture(), input: 199_000, totalTokens: 199_000 },
    });
    const result = await recoverEmbeddedRunOverflow(
      makeInput({ promptError: null, assistantOverflowCandidate }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: "Compaction timed out after 180000ms", summary: "Auto-compaction timed out" },
    { reason: "The summary provider is unavailable", summary: "Auto-compaction failed" },
  ])("preserves a precheck compaction failure: $reason", async ({ reason, summary }) => {
    mocks.compact.mockResolvedValueOnce({ ok: false, compacted: false, reason });
    const promptError = overflowError();
    const input = makeInput({
      promptError,
      attempt: {
        terminal: { kind: "failed", source: "precheck", error: promptError },
        preflightRecovery: { route: "compact_only" },
      },
    });

    const result = await recoverEmbeddedRunOverflow(input);

    expect(result).toMatchObject({
      action: "surface",
      kind: "compaction_failure",
      errorText: expect.stringContaining(reason),
      userText: expect.stringContaining(`${summary} before the next model request.`),
    });
    if (result.action !== "surface") {
      throw new Error("expected precheck compaction failure");
    }
    expect(result.userText).toContain("Try again or run /compact");
    expect(result.userText).not.toContain("Context overflow");
    expect(mocks.markProviderPromptRejected).not.toHaveBeenCalled();
    expect(input.prepareCurrentTranscriptRetry).not.toHaveBeenCalled();
  });

  it.each([true])(
    "truncates the active projection after mixed preflight compaction (successor=%s)",
    async (adoptsSuccessor) => {
      let sessionId = "session-1";
      getEmbeddedSessionPromptState(sessionId).toolResults.frozen.add("predecessor-only");
      const successorProjection = getEmbeddedSessionPromptState("rotated-session").toolResults;
      successorProjection.frozen.add("successor-only");
      mocks.truncateOversizedToolResults.mockReturnValueOnce({
        truncated: true,
        truncatedCount: 2,
      });
      const input = makeInput({
        getActiveSession: () => ({ id: sessionId, file: `/tmp/${sessionId}.jsonl` }),
        adoptCompactionTranscript: vi.fn(async () => {
          if (adoptsSuccessor) {
            sessionId = "rotated-session";
            return "session-1";
          }
          return undefined;
        }),
        attempt: {
          terminal: { kind: "failed", source: "precheck", error: overflowError() },
          sessionIdUsed: "session-1",
          messagesSnapshot: [],
          preflightRecovery: { route: "compact_then_truncate" },
        },
      });

      expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
      expect(mocks.truncateOversizedToolResults).toHaveBeenCalledWith(
        expect.objectContaining({
          projectionState: successorProjection,
          protectTrailingToolResults: true,
        }),
      );
      expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { successful: false, tokensAfter: 80_000 },
    { successful: true, tokensAfter: 150_000 },
  ])("bounds recovery until completed progress ($successful, $tokensAfter)", async (testCase) => {
    mocks.compact.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "Committed summary",
        tokensBefore: 150_000,
        tokensAfter: testCase.tokensAfter,
      },
    });
    const state = createEmbeddedRunContextRecoveryState();
    let committedCompactions = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const input = makeInput({ state });
      input.runParams.onAutoCompactionSucceeded = () => committedCompactions++;
      const result = await recoverEmbeddedRunOverflow(input);
      expect(result).toMatchObject(
        attempt < 3 || testCase.successful
          ? { action: "retry" }
          : { action: "surface", kind: "context_overflow" },
      );
      state.observeContextAccounting({
        kind: "model",
        contextTokens: 20,
        successful: testCase.successful,
      });
    }
    expect(committedCompactions).toBe(testCase.successful ? 4 : 3);
  });

  it("bypasses compaction for a compaction_failure overflow", async () => {
    const promptError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    const result = await recoverEmbeddedRunOverflow(makeInput({ promptError }));

    expect(result).toMatchObject({ action: "surface", kind: "compaction_failure" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("stops the run on a provider request-size ceiling instead of compacting", async () => {
    // Groq refuses an oversized single request with a 413 naming TPM that states both numbers.
    // Requested above Limit cannot be admitted by any bucket state, and compaction budgets
    // against the model's context window rather than this per-request ceiling, so the owner
    // must stop the run rather than compact, adopt a transcript, truncate, or retry.
    const promptError = new Error(
      "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
        "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
        "please reduce your message size and try again.",
    );

    // Oversized tool results are present, so a bypass that only skipped compaction would still
    // fall into fallback truncation and return { action: "retry" }. This pins real terminality.
    mocks.sessionLikelyHasOversizedToolResults.mockReturnValue(true);
    const input = makeInput({ promptError });

    const result = await recoverEmbeddedRunOverflow(input);

    // Returning { action: "none" } would hand the refusal back to the same-model rate-limit
    // retry that reported it, so the run must end here rather than merely skip compaction.
    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("provider request-size ceiling"),
    );
    // The run's recovery budget is untouched, so a genuine overflow later in the same run still
    // gets its full compaction attempts and its one tool-result truncation.
    expect(input.state.overflowCompactionAttempts).toBe(0);
    expect(input.state.toolResultTruncationAttempted).toBe(false);
  });

  it("rejects oversized pending input once and answers after its persisted history is compacted", async () => {
    const contextWindow = 40_000;
    const systemPrompt = "Follow the project rules. ".repeat(2_000);
    const oversized = "Oversized source material. ".repeat(8_000);
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "Remember copper.", timestamp: 1 });
    manager.appendMessage(createAssistant(testModel, [{ type: "text", text: "ACK" }]));
    manager.appendMessage({ role: "user", content: oversized, timestamp: 3 });
    const before = structuredClone(manager.getBranch());
    const requestBudget = createCompactionRequestBudget({
      contextWindow,
      reserveTokens: 10_000,
      systemPrompt,
      pendingPrompt: oversized,
    });
    const preflight = await prepareEmbeddedAttemptPromptPreflight({
      attempt: {
        provider: testModel.provider,
        modelId: testModel.id,
        model: testModel,
        sessionId: "session-1",
        sessionFile: "unused",
      },
      compactionReplayEnabled: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget: contextWindow,
      hookMessagesForCurrentPrompt: manager.buildSessionContext().messages,
      includeBoundaryTimestamp: false,
      promptForPrecheck: oversized,
      pendingInputTokens: requestBudget.pendingTokens,
      reserveTokens: 10_000,
      sessionMessageCount: 3,
      systemPrompt,
      toolResultMaxChars: 32_000,
      state: {
        contextBudgetStatus: undefined,
        preflightRecovery: undefined,
        promptError: null,
        promptErrorSource: null,
        skipPromptSubmission: false,
      },
    });
    expect(preflight.skipPromptSubmission).toBe(true);
    const input = makeInput({
      contextTokenBudget: contextWindow,
      promptError: preflight.promptError,
      attempt: {
        terminal: { kind: "failed", source: "precheck", error: preflight.promptError },
        preflightRecovery: preflight.preflightRecovery,
      },
    });
    input.state.compactionRequestBudget = requestBudget;
    expect(await recoverEmbeddedRunOverflow(input)).toMatchObject({
      action: "surface",
      kind: "context_overflow",
      userText: expect.stringContaining("Send a smaller message"),
    });
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
    expect(input.state.overflowCompactionAttempts).toBe(0);
    expect(manager.getBranch()).toEqual(before);

    const pendingPrompt = "What is the code word?";
    const pendingUserIdempotencyKey = "normal-follow-up";
    const pendingUser = {
      role: "user" as const,
      content: pendingPrompt,
      timestamp: 4,
      idempotencyKey: pendingUserIdempotencyKey,
    };
    manager.appendMessage(pendingUser);
    const { session } = await createTestSession({
      model: { ...testModel, contextWindow },
      sessionManager: manager,
      systemPrompt,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 20_000, reserveTokens: 10_000 },
        retry: { enabled: false },
      }),
    });
    streamMocks.streamSimple.mockImplementation((model, context) => {
      const text = session.isCompacting ? "The code word is copper." : "copper";
      if (!session.isCompacting) {
        expect(JSON.stringify(context.messages)).not.toContain(oversized);
        expect(JSON.stringify(context.messages)).toContain("copper");
        expect(Math.ceil(JSON.stringify(context).length / 4)).toBeLessThan(contextWindow - 10_000);
      }
      return createAssistantResultStream(createAssistant(model, [{ type: "text", text }]));
    });
    mocks.compact.mockImplementation(async ({ runtimeContext }) => {
      const outcome = await session[agentSessionAutomaticCompaction](
        undefined,
        "unresolved",
        undefined,
        readCompactionAccountingRecorder(runtimeContext),
      );
      if (outcome.status !== "completed") {
        throw new Error(outcome.reason);
      }
      return {
        ok: true,
        compacted: true,
        result: { ...outcome.result, tokensAfter: outcome.tokensAfter },
      };
    });
    input.state.compactionRequestBudget = createCompactionRequestBudget({
      contextWindow,
      reserveTokens: 10_000,
      systemPrompt,
      pendingPrompt,
      pendingUserIdempotencyKey,
    });
    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
    await session.prompt(pendingPrompt, { persistedUserIdempotencyKey: pendingUserIdempotencyKey });
    expect(session.getLastAssistantText()).toBe("copper");
    expect(manager.getEntry(before.at(-1)!.id)).toMatchObject({ message: { content: oversized } });
  });

  it("recovers overflow reported only by the assistant error text", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        promptError: null,
        assistantErrorText: "request_too_large: Request size exceeds model context window",
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  });

  it("does not inherit stale assistant overflow after a non-overflow prompt error", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        promptError: new Error("transport disconnected"),
        assistantErrorText: "request_too_large: Request size exceeds model context window",
      }),
    );

    expect(result).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it.each(["mid-turn"] as const)(
    "compacts predicted prompt pressure as a budget request with source=%s",
    async (source) => {
      const promptError = overflowError();
      const input = makeInput({
        promptError,
        attempt: {
          terminal: { kind: "failed", source: "precheck", error: promptError },
          preflightRecovery: {
            route: "compact_then_truncate",
            source,
            estimatedPromptTokens: 268_138,
            promptBudgetBeforeReserve: 241_616,
            overflowTokens: 26_522,
          },
        },
      });
      const result = await recoverEmbeddedRunOverflow(input);

      expect(result).toEqual({ action: "retry" });
      expect(mocks.compact).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenBudget: 241_616,
          currentTokenCount: 268_138,
          runtimeContext: expect.objectContaining({ trigger: "budget" }),
          runtimeSettings: expect.objectContaining({
            diagnostics: expect.objectContaining({ degradedReason: null }),
          }),
        }),
      );
      expect(input.prepareCurrentTranscriptRetry).toHaveBeenCalledOnce();
      expect(input.prepareCompactedTranscriptRetry).not.toHaveBeenCalled();
      expect(mocks.markProviderPromptRejected).not.toHaveBeenCalled();
      expect(input.runOwnsCompactionBeforeHook).toHaveBeenCalledWith("context budget recovery");
      expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
        "context budget recovery",
        expect.objectContaining({ compacted: true, ok: true }),
        undefined,
      );
      expect(
        readCompactionAccountingRecorder(mocks.compact.mock.calls[0]?.[0]?.runtimeContext),
      ).toMatchObject({ pendingRequestState: "unresolved" });
    },
  );

  it("keeps the raw budget for provider overflow with preflight metadata", async () => {
    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        promptError: new Error("Context window exceeded: requested 12,000 tokens"),
        attempt: {
          preflightRecovery: {
            route: "compact_then_truncate",
            source: "mid-turn",
            estimatedPromptTokens: 268_138,
            promptBudgetBeforeReserve: 241_616,
            overflowTokens: 26_522,
          },
        },
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(mocks.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 200_000,
        currentTokenCount: 12_000,
        runtimeContext: expect.objectContaining({ trigger: "overflow" }),
      }),
    );
  });

  it("does not reset the overflow-compaction budget after an in-attempt compaction", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    const input = makeInput({ state, attemptCompactionCount: 1 });
    const result = await recoverEmbeddedRunOverflow(input);

    expect(result).toEqual({ action: "retry" });
    expect(state.overflowCompactionAttempts).toBe(1);
    expect(input.markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("resets stale token state after an empty preflight compaction", async () => {
    const state = createEmbeddedRunContextRecoveryState();
    state.lastCompactionTokensAfter = 80_000;
    state.lastContextBudgetStatus = {
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 1,
      provider: "openai",
      model: "gpt-test",
      route: "compact_only",
      shouldCompact: true,
      estimatedPromptTokens: 268_138,
      contextTokenBudget: 200_000,
      promptBudgetBeforeReserve: 196_000,
      reserveTokens: 4_000,
      effectiveReserveTokens: 4_000,
      remainingPromptBudgetTokens: 0,
      overflowTokens: 72_138,
      toolResultReducibleChars: 0,
      messageCount: 0,
      unwindowedMessageCount: 0,
    };
    mocks.compact.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "no real conversation messages",
    });
    mocks.isNoRealConversationCompactionNoop.mockReturnValueOnce(true);

    const result = await recoverEmbeddedRunOverflow(
      makeInput({
        state,
        attempt: { preflightRecovery: { route: "compact_only" } },
      }),
    );

    expect(result).toEqual({ action: "retry" });
    expect(state.lastCompactionTokensAfter).toBeUndefined();
    expect(state.lastContextBudgetStatus).toBeUndefined();
    expect(mocks.resetNoRealConversationTokenSnapshot).toHaveBeenCalledWith({
      sessionTarget: undefined,
      sessionPersistence: undefined,
      assertActive: expect.any(Function),
    });
  });
});
