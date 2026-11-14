import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createMockUsage } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { normalizeEmbeddedRunAttempt } from "./run/attempt-normalization.js";
import {
  makeAttempt,
  makeNormalizationInput,
  makePromptState,
} from "./run/attempt-normalization.test-support.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import { MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT } from "./run/idle-timeout-breaker.js";
import { toNormalizedUsage } from "./usage-accumulator.js";

function withAssistant(assistant: ReturnType<typeof makeCliUsageAssistant>) {
  return { lastAssistant: assistant as never, currentAttemptAssistant: assistant as never };
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

describe("normalizeEmbeddedRunAttempt", () => {
  it.each(["settled", "aborted"])(
    "preserves committed accounting after an attempt is %s without replacing its request budget",
    (retirement) => {
      const state = createEmbeddedRunContextRecoveryState();
      const controller = new AbortController();
      const onBudget = vi.fn();
      const first = state.beginAttempt(controller.signal, onBudget);
      const budget = {
        contextWindow: 32_768,
        reserveTokens: 8_192,
        fixedTokens: 100,
        pendingTokens: 10,
      };
      first.onCompactionRequestBudget(budget);
      first.onContextAccountingEvent({ kind: "compaction", tokensAfter: 400 });
      if (retirement === "settled") {
        first.close();
      } else {
        controller.abort();
      }
      first.onCompactionRequestBudget({ ...budget, fixedTokens: 999 });
      // Committed accounting still settles after foreground budget publication closes.
      first.onContextAccountingEvent({ kind: "compaction", tokensAfter: 200 });
      expect(state.compactionRequestBudget).toBe(budget);
      expect(onBudget.mock.calls).toEqual([[undefined], [budget]]);
      expect(first.recordedCompactionCount).toBe(2);
      expect(state.autoCompactionCount).toBe(2);
      expect(state.currentContextSnapshot).toEqual({ tokens: 200 });

      const next = state.beginAttempt(undefined, onBudget);
      next.onContextAccountingEvent({ kind: "model", contextTokens: 250, successful: true });
      expect(next.recordedCompactionCount).toBe(0);
      expect(state.compactionRequestBudget).toBeUndefined();
      expect(state.autoCompactionCount).toBe(2);
      expect(state.currentContextSnapshot).toEqual({ tokens: 250 });
    },
  );

  it("keeps the physical-attempt source when idle timeouts trip the breaker despite billed partial output", async () => {
    const attempt = {
      ...makeAttempt(),
      modelAttempt: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialSource: { kind: "profile" as const },
      },
      terminal: { kind: "timeout" as const, phase: "prompt" as const, source: "idle" as const },
      attemptUsage: { output: 36 },
    };
    const input = makeNormalizationInput(attempt);
    let result: Awaited<ReturnType<typeof normalizeEmbeddedRunAttempt>> | undefined;
    for (let index = 0; index < MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT; index += 1) {
      result = await normalizeEmbeddedRunAttempt(input);
    }

    assert(result?.action === "complete", `expected complete, got ${result?.action}`);
    expect(result.result.meta.agentMeta?.credentialSource).toEqual({ kind: "profile" });
  });

  it("waits for pending user-turn persistence before deriving retry suppression", async () => {
    const persistence = createDeferred();
    const state = makePromptState(async () => {
      await persistence.promise;
      state.activePrompt.persisted = true;
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

    persistence.resolve();
    const result = await resultPromise;

    expect(result.action).toBe("proceed");
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it.each([
    ["mid-turn truncation", 2, "recovery", 1],
    ["no-op after a successful tool", 0, "progress_continuation", 1],
    ["compaction with current-attempt provenance", undefined, "recovery", 0],
  ] as const)(
    "preserves retry accounting for %s",
    async (_name, truncatedCount, kind, continues) => {
      const state = makePromptState();
      const assistant = makeCliUsageAssistant("stop");
      const attempt = makeAttempt(
        {
          route: continues ? "truncate_tool_results_only" : "compact_only",
          handled: true,
          ...(continues ? { source: "mid-turn" as const } : {}),
          truncatedCount: truncatedCount ?? 0,
        },
        continues
          ? truncatedCount
            ? {
                ...withAssistant({
                  ...assistant,
                  api: "openai-chatgpt-responses",
                  usage: createMockUsage(150_000, 100),
                }),
                attemptUsage: { input: 2_000, output: 100, total: 2_100, cost: { total: 0.125 } },
              }
            : { toolMetas: [{ toolName: "read", isError: false }] }
          : { ...withAssistant(assistant), messagesSnapshot: [assistant] as never },
      );
      const input = makeNormalizationInput(attempt, state);
      const priorUsage = { input: 42_000, output: 1_000, total: 43_000 };
      input.lastRunPromptUsage = truncatedCount
        ? {
            ...priorUsage,
            contextUsage: { state: "available", promptTokens: 42_000, totalTokens: 43_000 },
          }
        : priorUsage;
      const result = await normalizeEmbeddedRunAttempt(input);
      assert(result.action === "retry", `expected retry, got ${result.action}`);
      expect(result).toMatchObject({ retryKind: kind });
      expect(state.continueFromCurrentTranscript).toHaveBeenCalledTimes(continues);
      if (continues) {
        expect(state.markOwnedTranscriptRetry).toHaveBeenCalledTimes(truncatedCount ? 1 : 0);
      }
      expect(result.lastRunPromptUsage).toEqual(
        truncatedCount === 0
          ? input.lastRunPromptUsage
          : {
              contextUsage: { state: "unavailable" },
            },
      );
      if (!truncatedCount) {
        return;
      }
      const retryAttempt = makeAttempt(undefined, {
        attemptUsage: {
          input: 8_000,
          output: 500,
          total: 8_500,
          contextUsage: { state: "available", promptTokens: 8_000, totalTokens: 8_500 },
        },
      });
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
      expect(toNormalizedUsage(input.usageAccumulator)?.cost).toEqual({ total: 0.125 });
    },
  );

  it("writes canonical assistant abort lifecycle metadata", async () => {
    const assistant = makeCliUsageAssistant("aborted", "");
    const setTerminalLifecycleMeta = vi.fn();
    const attempt = makeAttempt(undefined, {
      ...withAssistant(assistant),
      setTerminalLifecycleMeta,
    });

    const result = await normalizeEmbeddedRunAttempt(makeNormalizationInput(attempt));

    assert(result.action === "proceed", `expected proceed, got ${result.action}`);
    result.setTerminalLifecycleMeta({ replayInvalid: false, livenessState: "blocked" });
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: false,
      livenessState: "blocked",
      stopReason: "aborted",
      aborted: true,
    });
  });
});
