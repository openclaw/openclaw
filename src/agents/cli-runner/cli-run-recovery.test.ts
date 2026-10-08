import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { FailoverError } from "../failover-error.js";
import { runCliRecovery } from "./cli-run-recovery.js";

afterEach(() => vi.restoreAllMocks());

function recovery(timeoutMs = 60_000) {
  const context = buildPreparedCliRunContext({ sessionKey: "agent:main:main", timeoutMs });
  context.openClawHistoryPrompt = "…earlier history…";
  context.reusableCliSession = { mode: "reuse", sessionId: "s1" };
  const error = new FailoverError("selected session expired", {
    reason: "session_expired",
    provider: "claude-cli",
  });
  const executeAttempt = vi
    .fn<Parameters<typeof runCliRecovery<{ done: true }>>[0]["executeAttempt"]>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ done: true });
  return {
    context,
    error,
    executeAttempt,
    run: () =>
      runCliRecovery({
        context,
        executeAttempt,
        finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure: async () => {},
      }),
  };
}

describe("cli-run-recovery retry budget", () => {
  it("keeps an integer monotonic retry budget after a wall-clock step", async () => {
    const { context, executeAttempt, run } = recovery();
    vi.spyOn(Date, "now").mockReturnValue(context.started + 120_000);
    vi.spyOn(performance, "now").mockReturnValue(12_345.4);
    context.startedMonotonicMs = 0;

    expect(await run()).toEqual({ done: true, meta: { durationMs: 1 } });
    expect(executeAttempt).toHaveBeenCalledTimes(2);
    expect(executeAttempt).toHaveBeenNthCalledWith(2, undefined, {
      timeoutMs: 47_654,
      forkCliSessionOnResume: false,
    });
  });

  it("treats a consumed retry budget as expired instead of passing a non-positive timeout", async () => {
    const { context, error, executeAttempt, run } = recovery(1_000);
    vi.spyOn(performance, "now").mockReturnValue(2_000.9);
    context.startedMonotonicMs = 0;

    await expect(run()).rejects.toBe(error);
    expect(executeAttempt).toHaveBeenCalledOnce();
  });
});
