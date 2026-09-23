import { describe, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { FailoverError } from "../failover-error.js";
import { runCliRecovery } from "./cli-run-recovery.js";

describe("cli-run-recovery retry budget", () => {
  it("keeps recovery budget after a forward wall-clock step", async () => {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };
    const error = new FailoverError("selected session expired", {
      reason: "session_expired",
      provider: "claude-cli",
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(context.started + 120_000);
    let attempts = 0;
    try {
      const result = await runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw error;
          }
          return { done: true };
        },
        finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      });
      expect(result).toEqual({ done: true, meta: { durationMs: 1 } });
      expect(attempts).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("passes an integer retry timeout to the next attempt when elapsed monotonic time is fractional", async () => {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };

    // Fractional elapsed monotonic time (12345.4ms) makes a naive subtraction
    // yield a fractional retry budget (47654.6ms) that the paired-node remote
    // decoder would reject (Number.isInteger). The budget must be floored.
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(12_345.4);
    context.startedMonotonicMs = 0;

    let retryTimeoutMs: number | undefined;
    let firstAttempt = true;
    const result = await runCliRecovery({
      context,
      executeAttempt: async (_sessionId, options) => {
        if (firstAttempt) {
          firstAttempt = false;
          throw new FailoverError("selected session expired", {
            reason: "session_expired",
            provider: "claude-cli",
          });
        }
        retryTimeoutMs = options?.timeoutMs;
        return { done: true };
      },
      finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
      finishDeliveredFailure: async () => undefined,
      onTerminalFailure: async () => {},
    });

    expect(retryTimeoutMs).toBe(47_654); // Math.floor(60000 - 12345.4), not 47655
    expect(Number.isInteger(retryTimeoutMs)).toBe(true);
    expect(result).toEqual({ done: true, meta: { durationMs: 1 } });
    nowSpy.mockRestore();
  });

  it("treats a consumed retry budget as expired instead of passing a non-positive timeout", async () => {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 1_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };

    // More elapsed monotonic time than the whole budget (2000.9ms consumed,
    // 1000ms budget): the remaining budget is negative and must be treated as
    // expired rather than passed to a retry attempt.
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(2_000.9);
    context.startedMonotonicMs = 0;

    const error = new FailoverError("selected session expired", {
      reason: "session_expired",
      provider: "claude-cli",
    });
    let attempts = 0;
    await expect(
      runCliRecovery({
        context,
        executeAttempt: async () => {
          attempts += 1;
          throw error;
        },
        finishAttempt: async () => ({ meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      }),
    ).rejects.toBe(error);

    expect(attempts).toBe(1); // only the original attempt; no retry with an expired budget
    nowSpy.mockRestore();
  });
});
