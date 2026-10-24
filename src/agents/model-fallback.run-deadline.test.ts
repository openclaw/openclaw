import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.restoreAllMocks());

it("gives a fallback candidate its own run budget after the primary spent it", async () => {
  const now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
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
  // Spend the primary budget before execution, leaving only the abort grace window.
  registration.initializeTiming({ now: now - TIMEOUT_MS });
  const release = await claimRpcSourceForTest(registration.entry);
  try {
    expect(registration.markExecutionStarted()).toBe(true);
    const { entry } = registration;
    const expiresAtAdmissionMs = getRpcSourceExpiresAt(entry) ?? 0;
    expect(expiresAtAdmissionMs - now).toBeLessThanOrEqual(TIMEOUT_MS);
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
    expect(deadlineDuringPrimaryMs).toBe(expiresAtAdmissionMs);
    expect(remainingAtFallbackMs).toBeGreaterThan(TIMEOUT_MS);
  } finally {
    // Settlement unregisters the deadline renewer even if an assertion fails.
    release();
    registration.cleanup();
    await registration.entry.input.settlement.promise;
  }
});
