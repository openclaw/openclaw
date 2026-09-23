import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
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

  it.each([
    { progress: true, budget: 8, expectedAttempts: 3 },
    { progress: false, budget: 8, expectedAttempts: 2 },
    { progress: undefined, budget: 8, expectedAttempts: 2 },
    { progress: true, budget: 1, expectedAttempts: 2 },
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
          expectedAttempts === 3 ? [1, 2] : [1],
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

  it("cancels a long retry wait when its lane expires without aborting the caller", async () => {
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
    vi.useFakeTimers();
    try {
      mockedSleep.mockImplementation((delayMs, signal) => {
        sleepSignal = signal;
        wait = sleep(delayMs, signal).finally(() => {
          waitSettled = true;
        });
        sleepStarted.resolve();
        return wait;
      });
      const assistant = makeAssistantMessageFixture({
        stopReason: "error",
        content: [],
        errorMessage: "429 rate limit exceeded; Retry-After: 3600",
      });
      mockedRunEmbeddedAttempt.mockResolvedValue(
        session.makeAttemptResult({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
        }),
      );
      pending = run({
        ...session.runParams,
        runId: "run-retry-lane-expiry",
        provider: "mock",
        model: "model",
        timeoutMs: 30_000,
        abortSignal: caller.signal,
      });
      const outcome = pending.catch((error: unknown) => error);
      await Promise.race([sleepStarted.promise, pending]);
      expect(mockedSleep).toHaveBeenCalledWith(3_600_000, expect.any(AbortSignal));
      expect(waitSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await outcome).toMatchObject({ name: "CommandLaneTaskTimeoutError" });
      expect(caller.signal.aborted).toBe(false);
      expect(sleepSignal?.aborted).toBe(true);
      expect(waitSettled).toBe(true);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    } finally {
      caller.abort();
      await wait?.catch(() => undefined);
      await pending?.catch(() => undefined);
      mockedSleep.mockImplementation(previousSleep ?? (async () => {}));
      vi.useRealTimers();
    }
  });

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
