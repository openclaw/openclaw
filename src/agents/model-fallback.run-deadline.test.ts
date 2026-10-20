// A fallback candidate must not inherit a run budget the primary already spent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerChatAbortController } from "../gateway/chat-abort.js";
import { claimRpcSourceForTest } from "../gateway/test-helpers.rpc-source.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { getRpcSourceExpiresAt } from "../sessions/session-controller.rpc-sources.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { createModelFallbackConfig } from "./test-helpers/model-fallback-config-fixture.js";

// mock-isolation: Auth-store discovery is unrelated I/O; this fixture owns only deadline and fallback composition.
vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

const TIMEOUT_MS = 60_000;
const RUN_ID = "run-deadline-renewal";

async function registerExecutingChatSendRun(now: number) {
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: "/synthetic/model-fallback-run-deadline",
      sessionKey: "agent:main",
      incarnation: "session-1",
    }),
    runId: RUN_ID,
    sessionId: "session-1",
    sessionKey: "agent:main",
    timeoutMs: TIMEOUT_MS,
    kind: "chat-send",
  });
  if (!registration.registered) {
    throw new Error("Expected a new controller RPC source");
  }
  // Admitted a full timeout ago: the primary candidate has already spent the
  // whole-run budget, leaving only the abort grace window.
  registration.initializeTiming({ now: now - TIMEOUT_MS });
  const release = await claimRpcSourceForTest(registration.entry);
  expect(registration.markExecutionStarted()).toBe(true);
  return { ...registration, release };
}

describe("model fallback run deadline", () => {
  let registration: Awaited<ReturnType<typeof registerExecutingChatSendRun>> | undefined;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  });

  // Settling the source unregisters its deadline renewer through the same
  // production path the gateway uses, so no registration leaks between tests
  // even when an assertion above fails.
  afterEach(async () => {
    registration?.release();
    registration?.cleanup();
    await registration?.entry.input.settlement.promise;
    registration = undefined;
    vi.restoreAllMocks();
  });

  it("gives a fallback candidate its own run budget after the primary spent it", async () => {
    const now = Date.now();
    registration = await registerExecutingChatSendRun(now);
    const { entry } = registration;
    // chat-send runs get no deadline refresh at execution start, so the entry
    // enters the fallback chain holding only the grace window.
    expect((getRpcSourceExpiresAt(entry) ?? 0) - now).toBeLessThanOrEqual(TIMEOUT_MS);

    const expiresAtAdmissionMs = getRpcSourceExpiresAt(entry) ?? 0;

    let deadlineDuringPrimaryMs = 0;
    let remainingAtFallbackMs = 0;
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        deadlineDuringPrimaryMs = getRpcSourceExpiresAt(entry) ?? 0;
        throw new FailoverError("primary timed out", { reason: "timeout" });
      })
      .mockImplementationOnce(() => {
        remainingAtFallbackMs = (getRpcSourceExpiresAt(entry) ?? 0) - Date.now();
        return Promise.resolve("ok");
      });

    const result = await runWithModelFallback({
      cfg: createModelFallbackConfig("openai/m1", ["anthropic/m2"]),
      provider: "openai",
      model: "m1",
      runId: RUN_ID,
      manifestPlugins: [],
      run,
    });

    expect(result.result).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
    // The primary keeps the whole-run budget the owner configured: renewal is
    // recovery-only, so a single-candidate run can never outlive its deadline.
    expect(deadlineDuringPrimaryMs).toBe(expiresAtAdmissionMs);
    // Only the fallback candidate is renewed. Without that renewal it starts
    // with the spent remainder and is killed by the run deadline instead of
    // being given a real attempt.
    expect(remainingAtFallbackMs).toBeGreaterThan(TIMEOUT_MS);
  });
});
