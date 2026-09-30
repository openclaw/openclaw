import { describe, expect, it, vi } from "vitest";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createEmbeddedRunReplayState, type EmbeddedRunReplayState } from "./replay-state.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import {
  createIdleTimeoutBreakerState,
  MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
} from "./run/idle-timeout-breaker.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import { createUsageAccumulator, toNormalizedUsage } from "./usage-accumulator.js";

function makeAttempt(
  preflightRecovery?: EmbeddedRunAttemptResult["preflightRecovery"],
): EmbeddedRunAttemptResult {
  return makeEmbeddedRunnerAttempt({ sessionIdUsed: "session-1", preflightRecovery });
}

function makeCliUsageAssistant(stopReason: "aborted" | "error" | "stop", text = "legacy reply") {
  return {
    role: "assistant",
    api: "cli",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [{ type: "text", text }],
    usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
    stopReason,
    timestamp: 1,
  };
}

function makePromptState(options: { waitForPersistence?: () => Promise<void> } = {}) {
  const activePrompt = { persisted: false, internal: false };
  const state = {
    sessionId: "session-1",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
    },
    activePrompt,
    suppressNextUserMessagePersistence: false,
    adoptSessionId: vi.fn(),
    waitForCurrentUserMessagePersistence: vi.fn(
      options.waitForPersistence ?? (async () => undefined),
    ),
    markOwnedTranscriptRetry: vi.fn(),
    continueFromCurrentTranscript: vi.fn(),
  };
  return state;
}

function makeNormalizationInput(
  attempt: EmbeddedRunAttemptResult,
  sessionPromptState: ReturnType<typeof makePromptState>,
  replayState: EmbeddedRunReplayState = createEmbeddedRunReplayState(),
): Parameters<typeof normalizeEmbeddedRunAttempt>[0] {
  return {
    runInput: {
      runParams: {
        sessionId: "session-1",
        sessionFile: "agent:main:main",
        config: {},
      },
      laneController: { throwIfAborted: vi.fn() },
      fallbackConfigured: false,
      startedAtMs: Date.now(),
      resolvedSessionKey: "agent:main:main",
    } as never,
    preparedRuntime: {
      nativeModelOwned: false,
      model: { id: "gpt-5.6-luna" },
      attemptAuthProfileStore: { profiles: {} },
      snapshot: () => ({
        effectiveModel: { provider: "openai", id: "gpt-5.6-luna" },
        outerContextTokenMeta: {},
        lastProfileId: undefined,
      }),
    } as never,
    dispatchedAttempt: { rawAttempt: attempt } as never,
    sessionPromptState: sessionPromptState as never,
    provider: "openai",
    modelId: "gpt-5.6-luna",
    bootstrapPromptWarningSignaturesSeen: [],
    usageAccumulator: createUsageAccumulator(),
    lastRunPromptUsage: undefined,
    idleTimeoutBreakerState: createIdleTimeoutBreakerState(),
    contextRecoveryState: createEmbeddedRunContextRecoveryState(),
    replayState,
    lastRetryFailoverReason: null,
  };
}

describe("normalizeEmbeddedRunAttempt", () => {
  it("keeps the physical-attempt source when the idle-timeout breaker completes the run", async () => {
    const attempt = {
      ...makeAttempt(),
      modelAttempt: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: { kind: "profile" as const },
      },
      terminal: { kind: "timeout" as const, phase: "prompt" as const, source: "idle" as const },
    };
    const input = makeNormalizationInput(attempt, makePromptState());
    let result: Awaited<ReturnType<typeof normalizeEmbeddedRunAttempt>> | undefined;
    for (let index = 0; index < MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT; index += 1) {
      result = await normalizeEmbeddedRunAttempt(input);
    }

    expect(result?.action).toBe("complete");
    if (!result || result.action !== "complete") {
      throw new Error(`expected complete, got ${result?.action ?? "no result"}`);
    }
    expect(result.result.meta.agentMeta?.credentialSource).toEqual({ kind: "profile" });
  });

  it("keeps attempt cost authoritative over a synthetic assistant zero-cost placeholder", async () => {
    const attempt = makeAttempt();
    attempt.attemptUsage = {
      input: 300_000,
      output: 200,
      cost: { total: 0.125 },
    };
    const assistant = {
      ...makeCliUsageAssistant("stop"),
      api: "openai-chatgpt-responses",
      usage: {
        input: 150_000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150_100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    attempt.lastAssistant = assistant as never;
    attempt.currentAttemptAssistant = assistant as never;
    const input = makeNormalizationInput(attempt, makePromptState());

    await normalizeEmbeddedRunAttempt(input);

    expect(toNormalizedUsage(input.usageAccumulator)).toMatchObject({
      input: 300_000,
      output: 200,
    });
    expect(toNormalizedUsage(input.usageAccumulator)?.cost).toEqual({ total: 0.125 });
  });

  it("waits for pending user-turn persistence before deriving retry suppression", async () => {
    let releasePersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const state = makePromptState({
      waitForPersistence: async () => {
        await persistence;
        state.activePrompt.persisted = true;
      },
    });
    let settled = false;

    const resultPromise = normalizeEmbeddedRunAttempt(
      makeNormalizationInput(makeAttempt(), state),
    ).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(state.waitForCurrentUserMessagePersistence).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(state.suppressNextUserMessagePersistence).toBe(false);

    releasePersistence?.();
    const result = await resultPromise;

    expect(result.action).toBe("proceed");
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("invalidates carried context usage after handled mid-turn truncation", async () => {
    const state = makePromptState();
    const attempt = makeAttempt({
      route: "truncate_tool_results_only",
      source: "mid-turn",
      handled: true,
      truncatedCount: 2,
    });
    attempt.attemptUsage = { input: 2_000, output: 100, total: 2_100 };
    const input = makeNormalizationInput(attempt, state);
    input.lastRunPromptUsage = {
      input: 42_000,
      output: 1_000,
      total: 43_000,
      contextUsage: { state: "available", promptTokens: 42_000, totalTokens: 43_000 },
    };

    const result = await normalizeEmbeddedRunAttempt(input);

    expect(result.action).toBe("retry");
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.retryKind).toBe("recovery");
    expect(state.markOwnedTranscriptRetry).toHaveBeenCalledOnce();
    expect(state.continueFromCurrentTranscript).toHaveBeenCalledOnce();
    expect(result.lastRunPromptUsage).toEqual({ contextUsage: { state: "unavailable" } });
    const retryAttempt = makeAttempt();
    retryAttempt.attemptUsage = {
      input: 8_000,
      output: 500,
      total: 8_500,
      contextUsage: { state: "available", promptTokens: 8_000, totalTokens: 8_500 },
    };
    const retryInput = makeNormalizationInput(retryAttempt, state);
    retryInput.lastRunPromptUsage = result.lastRunPromptUsage;
    expect(await normalizeEmbeddedRunAttempt(retryInput)).toMatchObject({
      action: "proceed",
      lastRunPromptUsage: retryAttempt.attemptUsage,
    });
    expect(toNormalizedUsage(input.usageAccumulator)).toMatchObject({
      input: 2_000,
      output: 100,
      total: 2_100,
    });
  });

  it.each([false, true])("budgets a no-op mid-turn retry (tool failed: %s)", async (isError) => {
    const state = makePromptState();
    const attempt = makeAttempt({
      route: "truncate_tool_results_only",
      source: "mid-turn",
      handled: true,
      truncatedCount: 0,
    });
    attempt.toolMetas = [{ toolName: "read", isError }];
    const input = makeNormalizationInput(attempt, state);
    input.lastRunPromptUsage = { input: 42_000, output: 1_000, total: 43_000 };
    const result = await normalizeEmbeddedRunAttempt(input);
    expect(result).toMatchObject({
      action: "retry",
      retryKind: isError ? "recovery" : "progress_continuation",
    });
    if (result.action !== "retry") {
      throw new Error(`expected retry, got ${result.action}`);
    }
    expect(result.lastRunPromptUsage).toEqual(input.lastRunPromptUsage);
    expect(state.markOwnedTranscriptRetry).not.toHaveBeenCalled();
    expect(state.continueFromCurrentTranscript).toHaveBeenCalledOnce();
  });

  it("keeps replay state unsafe after a later clean attempt", async () => {
    const state = makePromptState();
    let replayState = createEmbeddedRunReplayState();
    for (const replaySafe of [false, true]) {
      const input = makeNormalizationInput(
        {
          ...makeAttempt(),
          replayMetadata: { replaySafe, hadPotentialSideEffects: !replaySafe },
        },
        state,
        replayState,
      );
      const result = await normalizeEmbeddedRunAttempt(input);
      expect(result.action).toBe("proceed");
      if (result.action !== "proceed") {
        throw new Error(`expected proceed, got ${result.action}`);
      }
      replayState = result.replayState;
      expect(replayState).toEqual({ replayInvalid: true, hadPotentialSideEffects: true });
    }
  });

  it("writes canonical assistant abort lifecycle metadata", async () => {
    const state = makePromptState();
    const assistant = makeCliUsageAssistant("aborted", "");
    const setTerminalLifecycleMeta = vi.fn();
    const attempt = makeAttempt();
    attempt.lastAssistant = assistant as never;
    attempt.currentAttemptAssistant = assistant as never;
    attempt.setTerminalLifecycleMeta = setTerminalLifecycleMeta;

    const result = await normalizeEmbeddedRunAttempt(makeNormalizationInput(attempt, state));

    expect(result.action).toBe("proceed");
    if (result.action !== "proceed") {
      throw new Error(`expected proceed, got ${result.action}`);
    }
    result.setTerminalLifecycleMeta({ replayInvalid: false, livenessState: "blocked" });
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
      stopReason: "aborted",
      aborted: true,
    });
  });

  it.each([false, true])(
    "preserves context provenance across a retry (current: %s)",
    async (current) => {
      const assistant = makeCliUsageAssistant("stop");
      const attempt = makeAttempt({ route: "compact_only", handled: true, truncatedCount: 0 });
      attempt.messagesSnapshot = [assistant] as never;
      attempt.lastAssistant = assistant as never;
      if (current) {
        attempt.currentAttemptAssistant = assistant as never;
      }
      const state = makePromptState();
      const input = makeNormalizationInput(attempt, state);
      input.lastRunPromptUsage = { input: 42_000, output: 1_000, total: 43_000 };
      const result = await normalizeEmbeddedRunAttempt(input);
      expect(state.continueFromCurrentTranscript).not.toHaveBeenCalled();
      expect(result.action).toBe("retry");
      if (result.action !== "retry") {
        throw new Error(`expected retry, got ${result.action}`);
      }
      expect(result.lastRunPromptUsage).toEqual(
        current ? { contextUsage: { state: "unavailable" } } : input.lastRunPromptUsage,
      );
    },
  );
});
