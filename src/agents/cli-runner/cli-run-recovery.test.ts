import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { FailoverError } from "../failover-error.js";
import { runCliRecovery } from "./cli-run-recovery.js";
import { cliBackendLog } from "./log.js";

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

describe("cli-run-recovery delivered failures", () => {
  function deliveredFailureRun() {
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    });
    context.openClawHistoryPrompt = "…earlier history…";
    context.reusableCliSession = { mode: "reuse", sessionId: "s1" };
    const error = new FailoverError(
      "CLI JSONL output exceeded 20000 lines; refusing to parse output.",
      { reason: "format", provider: "claude-cli" },
    );
    const delivered = { done: true, meta: { durationMs: 1 } };
    const warn = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const onTerminalFailure = vi.fn(async () => {});
    const terminalWarnings = () =>
      warn.mock.calls
        .map(([message]) => message)
        .filter((message) => message.includes("cli terminal failure:"));
    return { context, error, delivered, warn, onTerminalFailure, terminalWarnings };
  }

  it("logs the terminal failure once when the first attempt fails after delivery", async () => {
    const { context, error, delivered, onTerminalFailure, terminalWarnings } =
      deliveredFailureRun();
    const executeAttempt = vi
      .fn<Parameters<typeof runCliRecovery<{ done: true }>>[0]["executeAttempt"]>()
      .mockRejectedValueOnce(error);

    const result = await runCliRecovery({
      context,
      executeAttempt,
      finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
      finishDeliveredFailure: async () => delivered,
      onTerminalFailure,
    });

    expect(result).toEqual(delivered);
    expect(terminalWarnings()).toHaveLength(1);
    expect(terminalWarnings()[0]).toContain("provider=claude-cli");
    expect(terminalWarnings()[0]).toContain("model=sonnet");
    expect(terminalWarnings()[0]).toContain("runId=run-test");
    expect(terminalWarnings()[0]).toContain("durationMs=");
    expect(terminalWarnings()[0]).toContain("CLI JSONL output exceeded 20000 lines");
    // The delivered-failure path already ran the failed agent-end hook, so the
    // terminal hook must not run a second time.
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it("logs the terminal failure once when a retry fails after delivery", async () => {
    const { context, delivered, onTerminalFailure, terminalWarnings } = deliveredFailureRun();
    const sessionExpired = new FailoverError("selected session expired", {
      reason: "session_expired",
      provider: "claude-cli",
    });
    const retryError = new FailoverError("CLI JSONL output exceeded 20000 lines.", {
      reason: "format",
      provider: "claude-cli",
    });
    const executeAttempt = vi
      .fn<Parameters<typeof runCliRecovery<{ done: true }>>[0]["executeAttempt"]>()
      .mockRejectedValueOnce(sessionExpired)
      .mockRejectedValueOnce(retryError);
    const finishDeliveredFailure = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(delivered);

    const result = await runCliRecovery({
      context,
      executeAttempt,
      finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
      finishDeliveredFailure,
      onTerminalFailure,
    });

    expect(result).toEqual(delivered);
    expect(executeAttempt).toHaveBeenCalledTimes(2);
    expect(terminalWarnings()).toHaveLength(1);
    expect(terminalWarnings()[0]).toContain("CLI JSONL output exceeded 20000 lines.");
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  it("still logs exactly once when no delivery evidence exists", async () => {
    const { context, error, onTerminalFailure, terminalWarnings } = deliveredFailureRun();
    const executeAttempt = vi
      .fn<Parameters<typeof runCliRecovery<{ done: true }>>[0]["executeAttempt"]>()
      .mockRejectedValueOnce(error);

    await expect(
      runCliRecovery({
        context,
        executeAttempt,
        finishAttempt: async (attempt) => ({ ...attempt, meta: { durationMs: 1 } }),
        finishDeliveredFailure: async () => undefined,
        onTerminalFailure,
      }),
    ).rejects.toBe(error);
    expect(terminalWarnings()).toHaveLength(1);
    expect(onTerminalFailure).toHaveBeenCalledOnce();
  });
});
