import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRequestLifecycle } from "./mcp-client-lifecycle.js";

describe("mcp request lifecycle timeout budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the request timeout on the monotonic clock when the wall clock rewinds across a human-input hold", async () => {
    vi.useFakeTimers();
    const lifecycle = createMcpRequestLifecycle(60_000);
    let observed: unknown;
    const request = async (signal: AbortSignal, holdForHumanInput: () => () => void) => {
      // NTP correction or VM resume rewinds the wall clock while the request executes.
      vi.setSystemTime(Date.now() - 60_000);
      const release = holdForHumanInput();
      await vi.advanceTimersByTimeAsync(5_000);
      release();
      return await new Promise<never>((_, reject) => {
        const rejectWithAbortReason = (reason: unknown) => {
          reject(reason instanceof Error ? reason : new Error(`aborted: ${String(reason)}`));
        };
        if (signal.aborted) {
          rejectWithAbortReason(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => rejectWithAbortReason(signal.reason), {
          once: true,
        });
      });
    };
    // Settlement observer is attached before fake time advances, so the
    // recorded outcome can be asserted without leaving real timers behind.
    let state: string | undefined;
    const outcome = lifecycle.run({ requestTimeoutMs: 5_000 }, request).then(
      () => {
        state = "resolved";
      },
      (error: unknown) => {
        observed = error;
        state = "rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state).toBe("rejected");
    await outcome;
    vi.useRealTimers();
    expect(lifecycle.didTimeout(observed)).toBe(true);
  });
});
