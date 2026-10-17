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
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import { prepareEmbeddedAttemptPromptPreflight } from "./run/attempt-prompt-preflight.js";
import { readCompactionAccountingRecorder } from "./run/compaction-accounting-bridge.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { recoverEmbeddedRunOverflow } from "./run/overflow-context-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
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

const overflowError = () => new Error("request_too_large: Request size exceeds context window");
const recover = (overrides: RecoveryInputOverrides = {}) =>
  recoverEmbeddedRunOverflow(makeInput(overrides));

async function expectCompactionRetry(overrides: RecoveryInputOverrides, assistantError = false) {
  expect(await recover(overrides)).toEqual({ action: "retry" });
  expect(mocks.compact).toHaveBeenCalledOnce();
  if (assistantError) {
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("source=assistantError"));
  }
}

function expectNoCompaction() {
  expect(mocks.compact).not.toHaveBeenCalled();
  expect(mocks.truncateOversizedToolResults).not.toHaveBeenCalled();
}

function precheckAttempt(
  preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"],
  error = overflowError(),
): Partial<EmbeddedRunAttemptResult> {
  return { terminal: { kind: "failed", source: "precheck", error }, preflightRecovery };
}

const predictedPressure = {
  route: "compact_then_truncate",
  source: "mid-turn",
  estimatedPromptTokens: 268_138,
  promptBudgetBeforeReserve: 241_616,
  overflowTokens: 26_522,
} as const;

const successfulCompaction = (tokensAfter = 80_000, summary = "Compacted session") =>
  makeCompactionSuccess({ summary, tokensBefore: 150_000, tokensAfter });

function makeAssistantMessage(
  input: Pick<AssistantMessage, "stopReason"> &
    Partial<
      Pick<AssistantMessage, "errorMessage" | "usage" | "errorType" | "errorCode" | "diagnostics">
    >,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    timestamp: 1,
    ...input,
    errorMessage: input.errorMessage,
    usage: input.usage ?? { ...createZeroUsageFixture(), input: 1, totalTokens: 1 },
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
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.compact.mockResolvedValue(successfulCompaction());
    mocks.isDebugEnabled.mockReturnValue(true);
    mocks.isNoRealConversationCompactionNoop.mockReturnValue(false);
    mocks.sessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mocks.truncateOversizedToolResults.mockReturnValue({
      truncated: false,
      truncatedCount: 0,
      reason: "nothing to truncate",
    });
  });

  it.each([
    { errorMessage: "400 Your input exceeds the context window of this model" },
    {
      errorMessage:
        '400 " Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input. Error Data: n/a, Additional Data: n/a"',
    },
    {
      errorMessage:
        "400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]",
      errorType: "invalid_request_error",
      errorCode: "invalid_parameter_error",
    },
  ])("compacts and retries the classified assistant overflow: $errorMessage", async (failure) => {
    const assistantOverflowCandidate = makeAssistantMessage({ stopReason: "error", ...failure });
    await expectCompactionRetry({ promptError: null, assistantOverflowCandidate }, true);
  });

  it.each([
    {
      errorMessage:
        "400 Invalid 'reasoning_effort' value: 'off'. Supported values: none, minimal, low, medium, high, xhigh.",
    },
    {
      errorMessage:
        "400 Failed to apply prompt template. The model is loaded with context length of only 4096 tokens.",
    },
    {
      errorMessage: "500 Unsupported parameter: context_length_exceeded",
      errorType: "invalid_request_error",
      errorCode: "unknown_parameter",
    },
    {
      errorMessage: "Anthropic refusal: prompt is too long.",
      diagnostics: [{ type: "provider_refusal" as const, timestamp: 1 }],
    },
  ])("does not recover a rejected or refused assistant: $errorMessage", async (failure) => {
    expect(
      await recover({
        promptError: null,
        assistantOverflowCandidate: makeAssistantMessage({ stopReason: "error", ...failure }),
        assistantErrorText: failure.errorMessage,
      }),
    ).toEqual({ action: "none" });
    expectNoCompaction();
    expect(mocks.markProviderPromptRejected).not.toHaveBeenCalled();
  });

  it("recovers a canonical zero-output length overflow", async () => {
    const assistantOverflowCandidate = makeAssistantMessage({
      stopReason: "length",
      usage: { ...createZeroUsageFixture(), input: 199_000, totalTokens: 199_000 },
    });
    await expectCompactionRetry({ promptError: null, assistantOverflowCandidate });
  });

  it.each([
    { reason: "Compaction timed out after 180000ms", summary: "Auto-compaction timed out" },
    { reason: "The summary provider is unavailable", summary: "Auto-compaction failed" },
  ])("preserves a precheck compaction failure: $reason", async ({ reason, summary }) => {
    mocks.compact.mockResolvedValueOnce({ ok: false, compacted: false, reason });
    const promptError = overflowError();
    const input = makeInput({
      promptError,
      attempt: precheckAttempt({ route: "compact_only" }, promptError),
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

  it("truncates the successor projection after mixed preflight compaction", async () => {
    let sessionId = "session-1";
    using predecessor = retainEmbeddedSessionPromptState(sessionId);
    using successor = retainEmbeddedSessionPromptState("rotated-session");
    predecessor.state.toolResults.frozen.add("predecessor-only");
    const successorProjection = successor.state.toolResults;
    successorProjection.frozen.add("successor-only");
    mocks.truncateOversizedToolResults.mockReturnValueOnce({
      truncated: true,
      truncatedCount: 2,
    });
    const input = makeInput({
      getActiveSession: () => ({ id: sessionId, file: `/tmp/${sessionId}.jsonl` }),
      adoptCompactionTranscript: vi.fn(async () => {
        sessionId = "rotated-session";
        return "session-1";
      }),
      attempt: precheckAttempt({ route: "compact_then_truncate" }),
    });

    expect(await recoverEmbeddedRunOverflow(input)).toEqual({ action: "retry" });
    expect(mocks.truncateOversizedToolResults).toHaveBeenCalledWith(
      expect.objectContaining({
        projectionState: successorProjection,
        protectTrailingToolResults: true,
      }),
    );
    expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
  });

  it.each([
    { successful: false, tokensAfter: 80_000 },
    { successful: true, tokensAfter: 150_000 },
  ])("bounds recovery until completed progress ($successful, $tokensAfter)", async (testCase) => {
    mocks.compact.mockResolvedValue(
      successfulCompaction(testCase.tokensAfter, "Committed summary"),
    );
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
    // A per-request TPM ceiling is terminal, even when truncation would otherwise be possible.
    const promptError = new Error(
      "413 Request too large for model `openai/gpt-oss-120b` in organization `org_x` " +
        "service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 8098, " +
        "please reduce your message size and try again.",
    );

    mocks.sessionLikelyHasOversizedToolResults.mockReturnValue(true);
    const input = makeInput({ promptError });

    const result = await recoverEmbeddedRunOverflow(input);

    expect(result).toMatchObject({ action: "surface", kind: "context_overflow" });
    expectNoCompaction();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("provider request-size ceiling"),
    );
    expect(input.state).toMatchObject({
      overflowCompactionAttempts: 0,
      toolResultTruncationAttempted: false,
    });
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
    const budgetDefaults = { contextWindow, reserveTokens: 10_000, systemPrompt };
    const requestBudget = createCompactionRequestBudget({
      ...budgetDefaults,
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
    expectNoCompaction();
    expect(input.state.overflowCompactionAttempts).toBe(0);
    expect(manager.getBranch()).toEqual(before);

    const pendingPrompt = "What is the code word?";
    const pendingUserIdempotencyKey = "normal-follow-up";
    manager.appendMessage({
      role: "user" as const,
      content: pendingPrompt,
      timestamp: 4,
      idempotencyKey: pendingUserIdempotencyKey,
    });
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
      ...budgetDefaults,
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
    await expectCompactionRetry(
      {
        promptError: null,
        assistantErrorText: "request_too_large: Request size exceeds model context window",
      },
      true,
    );
  });

  it("does not inherit stale assistant overflow after a non-overflow prompt error", async () => {
    const result = await recover({
      promptError: new Error("transport disconnected"),
      assistantErrorText: "request_too_large: Request size exceeds model context window",
    });

    expect(result).toEqual({ action: "none" });
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it("compacts predicted mid-turn prompt pressure as a budget request", async () => {
    const promptError = overflowError();
    const input = makeInput({
      promptError,
      attempt: precheckAttempt(predictedPressure, promptError),
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
  });

  it("keeps the raw budget for provider overflow with preflight metadata", async () => {
    const result = await recover({
      promptError: new Error("Context window exceeded: requested 12,000 tokens"),
      attempt: {
        preflightRecovery: predictedPressure,
      },
    });

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
