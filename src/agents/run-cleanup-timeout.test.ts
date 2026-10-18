// Verifies agent cleanup steps time out with bounded diagnostic logging.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentCleanupStep, createAgentCleanupScope } from "./run-cleanup-timeout.js";

const CLEANUP_TIMEOUT_DETAILS_MAX_CHARS = 512;
const CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX = "...[truncated]";

describe("agent cleanup timeout", () => {
  const log = {
    warn: vi.fn(),
  };

  const timeoutWithDetails = (getTimeoutDetails: () => string) =>
    runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "agent-trajectory-flush",
      cleanup: () => new Promise<never>(() => {}),
      log,
      timeoutMs: 5,
      getTimeoutDetails,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    log.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<{
    name: string;
    step: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    expectedTimeoutMs: number;
  }>([
    {
      name: "trajectory environment override",
      step: "openclaw-trajectory-flush",
      env: { OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000" },
      expectedTimeoutMs: 25_000,
    },
  ])("bounds stalled cleanup with $name", async ({ step, env, timeoutMs, expectedTimeoutMs }) => {
    const result = runAgentCleanupStep({
      runId: "run-1",
      sessionId: "session-1",
      step,
      cleanup: () => new Promise<never>(() => {}),
      log,
      env,
      timeoutMs,
    });

    await vi.advanceTimersByTimeAsync(expectedTimeoutMs - 1);
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      `agent cleanup timed out: runId=run-1 sessionId=session-1 step=${step} timeoutMs=${expectedTimeoutMs}`,
    );
  });

  it("keeps truncated cleanup timeout details UTF-16 safe", async () => {
    const prefixLength =
      CLEANUP_TIMEOUT_DETAILS_MAX_CHARS - CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX.length;
    const detailsPrefix = "a".repeat(prefixLength - 1);
    const oversizedDetails = `${detailsPrefix}😀${"b".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS)}`;

    const result = timeoutWithDetails(() => oversizedDetails);

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    const message = String(log.warn.mock.calls.at(-1)?.[0] ?? "");
    expect(message).toContain(
      ` details=${detailsPrefix}${CLEANUP_TIMEOUT_DETAILS_TRUNCATED_SUFFIX}`,
    );
    expect(message).not.toContain("�");
    expect(message.length).toBeLessThan(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=agent-trajectory-flush timeoutMs=5 details="
        .length +
        CLEANUP_TIMEOUT_DETAILS_MAX_CHARS +
        1,
    );
  });

  it("bounds cleanup timeout detail errors before logging", async () => {
    // Diagnostic failures must not produce unbounded logs or fail cleanup.

    const result = timeoutWithDetails(() => {
      throw new Error("details unavailable ".repeat(CLEANUP_TIMEOUT_DETAILS_MAX_CHARS));
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();

    const message = String(log.warn.mock.calls.at(-1)?.[0] ?? "");
    expect(message).toContain(" detailsError=details unavailable");
    expect(message).toContain("...[truncated]");
    expect(message.length).toBeLessThan(
      "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=agent-trajectory-flush timeoutMs=5 detailsError="
        .length +
        CLEANUP_TIMEOUT_DETAILS_MAX_CHARS +
        1,
    );
  });

  it.each([true])(
    "preserves nested cleanup uncertainty and the original run outcome (fails=%s)",
    async (fails) => {
      const failure = new Error("run failed");
      const outer = createAgentCleanupScope();
      const inner = createAgentCleanupScope();
      const result = outer.run(() =>
        inner.run(async () => {
          await runAgentCleanupStep({
            runId: "nested",
            sessionId: "isolated",
            step: "registered-owner",
            cleanup: async () => {
              throw new Error("cleanup failed");
            },
            log,
          });
          if (fails) {
            throw failure;
          }
          return "result";
        }),
      );
      if (fails) {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toBe("result");
      }
      expect(inner.outcome).toBe("uncertain");
      expect(outer.outcome).toBe("uncertain");
    },
  );
  it.each([
    { label: "completed", settles: true, fails: false, outcome: "closed" },
    { label: "late rejection", settles: false, fails: true, outcome: "uncertain" },
  ])(
    "bounds automatic cleanup and records $label ownership",
    async ({ settles, fails, outcome }) => {
      let settle!: () => void;
      const held = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const scope = createAgentCleanupScope();
      const result = scope.run(() =>
        runAgentCleanupStep({
          runId: "automatic",
          sessionId: "isolated",
          step: "registered-owner",
          log,
          timeoutMs: 5,
          cleanup: async () => {
            await held;
            if (fails) {
              throw new Error("teardown failed");
            }
          },
        }),
      );
      try {
        if (settles) {
          settle();
        }
        await vi.advanceTimersByTimeAsync(5);
        expect(scope.outcome).toBe(outcome);
        await expect(result).resolves.toBeUndefined();
      } finally {
        settle();
        await result;
      }
    },
  );
});
