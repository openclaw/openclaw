// Regression: wall-clock rewind (NTP jump) must not stretch the elapsed execution budget.
// The attempt deadline controller uses performance.now() for elapsed accounting so that
// a Date.now() correction backward cannot inflate the remaining timeoutMs or deflate
// the reported elapsed time.  This test exercises the full production attempt flow
// (prepareCodexAttemptConnection → createCodexAttemptTurnState → deadline controller)
// under a simulated NTP correction.
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { expectTimedOutAttempt } from "./attempt-terminal.test-support.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import * as attemptTurnState from "./run-attempt-turn-state.js";

setupRunAttemptTestHooks();

type TestParams = ReturnType<typeof createTestParams>;

function makeTestParams(overrides: Partial<TestParams> = {}): TestParams {
  return { ...createTestParams(), ...overrides };
}

function makeAgentMessageDelta(delta: string) {
  return {
    method: "item/agentMessage/delta" as const,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "msg-partial-1",
      delta,
    },
  };
}

async function expectTurnInterrupted(
  harness: ReturnType<typeof createStartedThreadHarness>,
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
      ),
    { interval: 1 },
  );
}

describe("Codex app-server monotonic attempt deadline", () => {
  it("preserves execution budget elapsed accounting under wall-clock rewind", async () => {
    vi.useFakeTimers();
    const baseWallClock = Date.now();
    const turnStateFactory = vi.spyOn(attemptTurnState, "createCodexAttemptTurnState");
    const harness = createStartedThreadHarness();
    const params = makeTestParams({ timeoutMs: 60_000 });
    const onAttemptTimeout = vi.fn();
    params.onAttemptTimeout = onAttemptTimeout;
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    expect(resolveActiveEmbeddedRunSessionId(params.sessionKey!)).toBe(params.sessionId);

    // Elapse 30 s of real (monotonic) time.  Send progress to keep the turn alive.
    await vi.advanceTimersByTimeAsync(30_000);
    await harness.notify(makeAgentMessageDelta("progress 0"));
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    expect(onAttemptTimeout).not.toHaveBeenCalled();

    // Simulate an NTP correction that jumps the wall clock 120 s backward.
    // On main (pre-fix), Date.now()-based elapsed accounting would report
    // elapsedMs ≈ 0 here instead of 60 000, because Date.now() moved backward.
    vi.setSystemTime(baseWallClock + 30_000 - 120_000);

    // Advance another 30 s of monotonic time — total elapsed = 60 s = budget.
    await vi.advanceTimersByTimeAsync(30_000);

    // The timeout must fire because the monotonic clock hit the 60 s budget.
    expectTimedOutAttempt(await run);
    expect(onAttemptTimeout).toHaveBeenCalledOnce();

    // Extract the timeout detail captured in the turn state.
    const turnState = turnStateFactory.mock.results[0];
    if (turnState?.type !== "return") {
      throw new Error("Codex attempt did not create its turn state");
    }
    const timeout = turnState.value.state.timeout;
    // The elapsed reporting must stay on the monotonic budget (≈60 s),
    // not deflated to 0 by the wall-clock rewind.
    expect(timeout?.timeoutMs).toBe(60_000);
    expect(timeout?.elapsedMs).toBeGreaterThanOrEqual(59_000);
    expect(timeout?.elapsedMs).toBeLessThanOrEqual(61_000);

    // Real-client cancellation: the harness must have sent turn/interrupt.
    await expectTurnInterrupted(harness);
  });
});
