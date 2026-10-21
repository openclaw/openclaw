import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentCleanupStep, createAgentCleanupScope } from "./run-cleanup-timeout.js";

const MAX_DETAILS = 512;
const TRUNCATED = "...[truncated]";

describe("agent cleanup timeout", () => {
  const log = { warn: vi.fn() };
  const runCleanup = (options: Partial<Parameters<typeof runAgentCleanupStep>[0]> = {}) =>
    runAgentCleanupStep({
      runId: "run-trajectory",
      sessionId: "session-trajectory",
      step: "agent-trajectory-flush",
      cleanup: () => new Promise<never>(() => {}),
      log,
      ...options,
    });
  const timeoutMessage =
    "agent cleanup timed out: runId=run-trajectory sessionId=session-trajectory step=agent-trajectory-flush timeoutMs=5";

  async function timeoutWithDetails(getTimeoutDetails: () => string, field = "details") {
    const result = runCleanup({ timeoutMs: 5, getTimeoutDetails });
    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBeUndefined();
    const message = String(log.warn.mock.calls.at(-1)?.[0] ?? "");
    expect(message.length).toBeLessThan(`${timeoutMessage} ${field}=`.length + MAX_DETAILS + 1);
    return message;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    log.warn.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("bounds stalled cleanup with the trajectory environment override", async () => {
    const result = runCleanup({
      runId: "run-1",
      sessionId: "session-1",
      step: "openclaw-trajectory-flush",
      env: { OPENCLAW_TRAJECTORY_FLUSH_TIMEOUT_MS: "25000" },
    });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      "agent cleanup timed out: runId=run-1 sessionId=session-1 step=openclaw-trajectory-flush timeoutMs=25000",
    );
  });

  it("keeps truncated cleanup timeout details UTF-16 safe", async () => {
    const prefixLength = MAX_DETAILS - TRUNCATED.length;
    const detailsPrefix = "a".repeat(prefixLength - 1);
    const message = await timeoutWithDetails(() => `${detailsPrefix}😀${"b".repeat(MAX_DETAILS)}`);
    expect(message).toContain(` details=${detailsPrefix}${TRUNCATED}`);
    expect(message).not.toContain("�");
  });

  it("bounds cleanup timeout detail errors before logging", async () => {
    const message = await timeoutWithDetails(() => {
      throw new Error("details unavailable ".repeat(MAX_DETAILS));
    }, "detailsError");
    expect(message).toContain(" detailsError=details unavailable");
    expect(message).toContain("...[truncated]");
  });

  it("preserves nested cleanup uncertainty and the original run failure", async () => {
    const failure = new Error("run failed");
    const outer = createAgentCleanupScope();
    const inner = createAgentCleanupScope();
    const result = outer.run(() =>
      inner.run(async () => {
        await runCleanup({
          runId: "nested",
          sessionId: "isolated",
          step: "registered-owner",
          cleanup: async () => {
            throw new Error("cleanup failed");
          },
        });
        throw failure;
      }),
    );
    await expect(result).rejects.toBe(failure);
    expect(inner.outcome).toBe("uncertain");
    expect(outer.outcome).toBe("uncertain");
  });
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
        runCleanup({
          runId: "automatic",
          sessionId: "isolated",
          step: "registered-owner",
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
