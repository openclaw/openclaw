import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeCompactionSuccess, makeOverflowError } from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedCompactDirect,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

describe("direct embedded retry lifecycle", () => {
  let run: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;
  beforeAll(async () => {
    run = await loadSharedRunIntegrationHarness();
  });
  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockReturnValue(false);
    mockedClassifyAssistantFailoverReason.mockReturnValue(null);
    mockedClassifyFailoverReason.mockReturnValue(null);
    session = await createSharedRunIntegrationSession();
  });
  afterEach(async () => {
    await session?.cleanup();
  });

  it.each(
    [false, true].flatMap((compact) =>
      ["reasoning", "empty", "whitespace", "zero-width"].map((output) => ({ compact, output })),
    ),
  )(
    "publishes an incomplete-turn failure for $output output (compaction=$compact)",
    async ({ compact, output }) => {
      useOpenAIPlatformAuthFixture();
      const { buildEmbeddedRunPayloads } =
        await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js");
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
      mockedCompactDirect.mockResolvedValue(makeCompactionSuccess({ summary: "Earlier context" }));
      const text =
        output === "zero-width"
          ? " \u200b\u200d\u2060 "
          : output === "whitespace"
            ? " \t\n\u0085"
            : "";
      const onAgentEvent = vi.fn();
      let attempts = 0;
      mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
        attempts += 1;
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        if (compact && attempts === 2) {
          return session.makeAttemptResult({
            assistantTexts: [],
            promptError: makeOverflowError(),
          });
        }
        const assistant = makeAssistantMessageFixture({
          provider: "openai",
          model: "gpt-5.6-sol",
          stopReason: "stop",
          errorMessage: undefined,
          content:
            output === "reasoning"
              ? [{ type: "thinking", thinking: "Internal reasoning", thinkingSignature: "fixture" }]
              : [{ type: "text", text }],
        });
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: { phase: "finishing", stopReason: "stop" },
        });
        return session.makeAttemptResult({
          assistantTexts: text ? [text] : [],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        });
      });
      const result = await run({
        ...session.runParams,
        provider: "openai",
        model: "gpt-5.6-sol",
        agentHarnessRuntimeOverride: "openclaw",
        onAgentEvent,
      });
      const notice = "⚠️ Agent couldn't generate a response. Please try again.";
      expect(result.payloads).toEqual([{ text: notice, isError: true }]);
      expect(result.meta).toMatchObject({
        aborted: false,
        stopReason: "error",
        error: { kind: "incomplete_turn", message: notice },
      });
      const terminals = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) => event.stream === "lifecycle" && ["end", "error"].includes(event.data.phase),
        );
      expect(terminals).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "error",
            stopReason: "error",
            error: notice,
            executionSettled: true,
          }),
        }),
      ]);
      expect(mockedCompactDirect).toHaveBeenCalledTimes(compact ? 1 : 0);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(
        (output === "reasoning" ? 3 : 2) + (compact ? 1 : 0),
      );
    },
  );

  it.each([
    { progress: true, budget: 8, expectedAttempts: 3 },
    { progress: false, budget: 8, expectedAttempts: 2 },
    { progress: true, budget: 1, expectedAttempts: 3 },
  ])(
    "recovers a later outage after model progress=$progress with retry budget=$budget",
    async ({ progress, budget, expectedAttempts }) => {
      const { buildEmbeddedRunPayloads } =
        await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js");
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
      let nowMs = Date.now();
      const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const onAgentEvent = vi.fn();
      let attempts = 0;
      try {
        mockedRunEmbeddedAttempt.mockImplementation(async () => {
          attempts += 1;
          if (attempts === 2) {
            // A resumed task can complete model/tool work for minutes before another outage.
            nowMs += 130_000;
          }
          const failed = attempts < 3;
          const assistant = makeAssistantMessageFixture({
            provider: "mock",
            model: "model",
            stopReason: failed ? "error" : "stop",
            content: failed ? [] : [{ type: "text", text: "Recovered reply" }],
            errorMessage: failed ? "An error occurred while processing the request." : undefined,
          });
          return session.makeAttemptResult({
            providerRetryMaxRetries: budget,
            hasSuccessfulModelResponse: attempts === 2 ? progress : false,
            assistantTexts: failed ? [] : ["Recovered reply"],
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            toolMetas: [{ toolName: "exec", replaySafe: false }],
          });
        });
        const result = await run({
          ...session.runParams,
          provider: "mock",
          model: "model",
          timeoutMs: 30 * 60_000,
          onAgentEvent,
        });
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(expectedAttempts);
        const retries = onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "run_status" && event.data.phase === "retrying");
        expect(retries.map((event) => event.data.retryAttempt)).toEqual(
          expectedAttempts === 3 ? [1, 1] : [1],
        );
        if (expectedAttempts === 3) {
          expect(result.payloads).toEqual(
            expect.arrayContaining([expect.objectContaining({ text: "Recovered reply" })]),
          );
        }
        for (const [attempt] of mockedRunEmbeddedAttempt.mock.calls.slice(1)) {
          expect(attempt.skipPreparedUserTurnMessage).toBe(true);
          expect(attempt.prompt).not.toBe(session.runParams.prompt);
        }
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each([true, false])(
    "bounds consecutive rate limits, not productive turns (progress=%s)",
    async (progress) => {
      const { buildEmbeddedRunPayloads } =
        await vi.importActual<typeof import("./run/payloads.js")>("./run/payloads.js");
      mockedBuildEmbeddedRunPayloads.mockImplementation(buildEmbeddedRunPayloads);
      const onAgentEvent = vi.fn();
      const providerError = "429 rate limit exceeded. Please try again in 221ms.";
      let attempts = 0;
      mockedRunEmbeddedAttempt.mockImplementation(async () => {
        attempts += 1;
        const failed = attempts < 40;
        const assistant = makeAssistantMessageFixture({
          provider: "mock",
          model: "model",
          stopReason: failed ? "error" : "stop",
          content: failed ? [] : [{ type: "text", text: "Recovered reply" }],
          errorMessage: failed ? providerError : undefined,
        });
        return session.makeAttemptResult({
          // Three failures per outage also exercise the outer run-loop guard.
          hasSuccessfulModelResponse: progress && attempts > 1 && attempts % 3 === 1,
          assistantTexts: failed ? [] : ["Recovered reply"],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          toolMetas: [{ toolName: "exec", replaySafe: false }],
        });
      });
      const result = await run({
        ...session.runParams,
        provider: "mock",
        model: "model",
        timeoutMs: 30 * 60_000,
        onAgentEvent,
      });
      expect(attempts).toBe(progress ? 40 : 10);
      const retries = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "run_status" && event.data.phase === "retrying");
      expect(retries.map((event) => event.data.retryAttempt)).toEqual(
        Array.from({ length: progress ? 39 : 9 }, (_, index) =>
          progress ? (index % 3) + 1 : index + 1,
        ),
      );
      if (progress) {
        expect(result.payloads).toEqual([expect.objectContaining({ text: "Recovered reply" })]);
      } else {
        expect(result.payloads).toEqual([
          expect.objectContaining({
            isError: true,
            text: expect.stringContaining("9 automatic retries without a completed model response"),
          }),
        ]);
        const lastResult = await mockedRunEmbeddedAttempt.mock.results.at(-1)?.value;
        expect(lastResult?.lastAssistant?.errorMessage).toBe(providerError);
      }
      for (const [attempt] of mockedRunEmbeddedAttempt.mock.calls.slice(1)) {
        expect(attempt.skipPreparedUserTurnMessage).toBe(true);
        expect(attempt.prompt).not.toBe(session.runParams.prompt);
      }
    },
  );

  it.each(["assistant", "prompt"] as const)(
    "explains exhausted rate-limit retries through the replay-safe %s failure path",
    async (source) => {
      // The shared harness normally disables coercion; exercise the real terminal
      // owner here so its structured exhaustion context reaches the thrown error.
      const failover = await import("../failover-error.js");
      const actualFailover =
        await vi.importActual<typeof import("../failover-error.js")>("../failover-error.js");
      vi.mocked(failover.coerceToFailoverError).mockImplementation(
        actualFailover.coerceToFailoverError,
      );
      const providerError = "429 rate limit exceeded. Please try again in 221ms.";
      mockedClassifyAssistantFailoverReason.mockReturnValue("rate_limit");
      mockedIsFailoverAssistantError.mockReturnValue(true);
      mockedIsRateLimitAssistantError.mockReturnValue(true);
      mockedClassifyFailoverReason.mockReturnValue("rate_limit");
      const assistant = makeAssistantMessageFixture({
        stopReason: "error",
        content: [],
        errorMessage: providerError,
      });
      mockedRunEmbeddedAttempt.mockResolvedValue(
        session.makeAttemptResult({
          providerRetryMaxRetries: 1,
          assistantTexts: [],
          ...(source === "assistant"
            ? { lastAssistant: assistant, currentAttemptAssistant: assistant }
            : { promptError: new Error(providerError), promptErrorSource: "prompt" }),
        }),
      );
      await expect(run({ ...session.runParams, provider: "mock", model: "model" })).rejects.toThrow(
        "1 automatic retry without a completed model response",
      );
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(assistant.errorMessage).toBe(providerError);
    },
  );

  it.each([false, true])(
    "cancels retry waits on lane expiry or caller abort after progress (progress=%s)",
    async (progress) => {
      const { sleepWithAbort } = await import("../../infra/backoff.js");
      const { sleepWithAbort: sleep } = await import("../../../packages/retry/src/index.js");
      const mockedSleep = vi.mocked(sleepWithAbort);
      const previousSleep = mockedSleep.getMockImplementation();
      const caller = new AbortController();
      let sleepSignal: AbortSignal | undefined;
      let wait: Promise<void> | undefined;
      let waitSettled = false;
      let pending: ReturnType<typeof run> | undefined;
      const sleepStarted = createDeferred();
      const shortSleepsStarted = [createDeferred(), createDeferred(), createDeferred()];
      const remainingShortSleeps = [...shortSleepsStarted];
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      vi.useFakeTimers();
      try {
        mockedSleep.mockImplementation((delayMs, signal) => {
          sleepSignal = signal;
          waitSettled = false;
          wait = sleep(delayMs, signal).finally(() => {
            waitSettled = true;
          });
          if (delayMs === 3_600_000) {
            sleepStarted.resolve();
          } else {
            remainingShortSleeps.shift()?.resolve();
          }
          return wait;
        });
        let attempts = 0;
        mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
          attempts += 1;
          // Each model attempt keeps its own budget; caller cancellation spans them.
          expect(params.timeoutMs).toBe(30_000);
          params.onAttemptDeadlineChanged?.({
            kind: "bounded",
            deadlineAtMs: Date.now() + params.timeoutMs,
          });
          const assistant = makeAssistantMessageFixture({
            stopReason: "error",
            content: [],
            errorMessage: `429 rate limit exceeded; Retry-After: ${progress && attempts < 4 ? 1 : 3600}`,
          });
          return session.makeAttemptResult({
            lastAssistant: assistant,
            currentAttemptAssistant: assistant,
            hasSuccessfulModelResponse: progress && attempts > 1,
          });
        });
        pending = run({
          ...session.runParams,
          runId: "run-retry-lane-expiry",
          provider: "mock",
          model: "model",
          agentHarnessRuntimeOverride: "openclaw",
          timeoutMs: 30_000,
          abortSignal: caller.signal,
        });
        const outcome = pending.catch((error: unknown) => error);
        if (progress) {
          for (const started of shortSleepsStarted) {
            await Promise.race([started.promise, pending]);
            await vi.advanceTimersByTimeAsync(1_000);
          }
        }
        await Promise.race([sleepStarted.promise, pending]);
        expect(mockedSleep).toHaveBeenCalledWith(3_600_000, expect.any(AbortSignal));
        expect(waitSettled).toBe(false);
        if (progress) {
          caller.abort();
          expect(await outcome).toMatchObject({ name: "AbortError" });
        } else {
          await vi.advanceTimersByTimeAsync(60_001);
          expect(await outcome).toMatchObject({ name: "CommandLaneTaskTimeoutError" });
        }
        expect(caller.signal.aborted).toBe(progress);
        expect(sleepSignal?.aborted).toBe(true);
        expect(waitSettled).toBe(true);
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(progress ? 4 : 1);
      } finally {
        caller.abort();
        await wait?.catch(() => undefined);
        await pending?.catch(() => undefined);
        mockedSleep.mockImplementation(previousSleep ?? (async () => {}));
        random.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("clears a failed attempt receipt before a retry fails ahead of lifecycle start", async () => {
    const onAgentEvent = vi.fn();
    const onAttemptStart = vi.fn();
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (params) => {
        const assistant = makeAssistantMessageFixture({
          provider: "mock",
          model: "model",
          stopReason: "error",
          content: [],
          errorMessage: "provider failure",
        });
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: "finishing",
            error: "provider failure",
            assistantTranscriptIdempotencyKey: "saved-A",
          },
        });
        return session.makeAttemptResult({
          assistantTexts: [],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          assistantTranscriptIdempotencyKey: "saved-A",
        });
      })
      .mockImplementationOnce(async (params) => {
        expect(params).not.toHaveProperty("onAttemptStart");
        throw new Error("preparation B failed");
      });
    await expect(
      run({ ...session.runParams, provider: "mock", model: "model", onAgentEvent, onAttemptStart }),
    ).rejects.toThrow("preparation B failed");
    expect(onAttemptStart).toHaveBeenCalledTimes(2);
    const terminals = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.stream === "lifecycle" && ["end", "error"].includes(event.data.phase),
      );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].data).toMatchObject({
      error: "preparation B failed",
      executionSettled: true,
    });
    expect(terminals[0].data.assistantTranscriptIdempotencyKey).toBeUndefined();
  });

  it.each(["recovered", "exhausted", "caller-deferred"] as const)(
    "publishes only the owning terminal after %s attempts",
    async (outcome) => {
      let attempts = 0;
      const onAgentEvent = vi.fn();
      mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
        expect(params).not.toHaveProperty("onAttemptStart");
        const failed = ++attempts === 1 || outcome === "exhausted";
        const assistant = makeAssistantMessageFixture({
          provider: "mock",
          model: "model",
          stopReason: failed ? "error" : "stop",
          content: failed ? [] : [{ type: "text", text: "Recovered reply" }],
          errorMessage: failed ? "provider failure" : undefined,
        });
        await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
        // Harnesses defer their attempt terminal when the logical-run owner requests it.
        await params.onAgentEvent?.({
          stream: "lifecycle",
          data: {
            phase: params.deferTerminalLifecycle ? "finishing" : failed ? "error" : "end",
            ...(failed ? { error: "provider failure" } : {}),
            assistantTranscriptIdempotencyKey: `saved-${attempts}`,
          },
        });
        return session.makeAttemptResult({
          assistantTexts: failed ? [] : ["Recovered reply"],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          assistantTranscriptIdempotencyKey: `saved-${attempts}`,
        });
      });
      await run({
        ...session.runParams,
        provider: "mock",
        model: "model",
        onAgentEvent,
        deferTerminalLifecycle: outcome === "caller-deferred",
      });
      const terminals = onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter(
          (event) => event.stream === "lifecycle" && ["end", "error"].includes(event.data.phase),
        );
      expect(attempts).toBe(outcome === "exhausted" ? 4 : 2);
      expect(terminals).toEqual(
        outcome === "caller-deferred"
          ? []
          : [
              expect.objectContaining({
                stream: "lifecycle",
                data: expect.objectContaining({
                  phase: outcome === "exhausted" ? "error" : "end",
                  executionSettled: true,
                  assistantTranscriptIdempotencyKey: `saved-${attempts}`,
                }),
              }),
            ],
      );
    },
  );
});
