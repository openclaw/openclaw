// Browser tests cover sdk node runtime plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForBrowserStartup, withTimeout } from "./sdk-node-runtime.js";

describe("withTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("excludes shared startup from nested Gateway and local request deadlines", async () => {
    vi.useFakeTimers();
    const ready = Promise.withResolvers<string>();
    const request = withTimeout(
      () => withTimeout(() => waitForBrowserStartup(() => ready.promise), 20_000),
      20_000,
    );
    const result = request.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(31_000);
    ready.resolve("ready");
    expect(await result).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects the deadline even when work resolves while handling cancellation", async () => {
    vi.useFakeTimers();
    let workSignal: AbortSignal | undefined;
    const pending = withTimeout(
      (signal) => {
        workSignal = signal;
        return new Promise<string>((resolve) => {
          signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
        });
      },
      100,
      "browser request",
    );
    const rejected = expect(pending).rejects.toThrow("browser request timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(workSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps oversized timeouts before arming the abort timer", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    await expect(
      withTimeout(async () => "ok", Number.MAX_SAFE_INTEGER, "browser request"),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps the paused remaining budget on the monotonic clock across a wall-clock step", async () => {
    vi.useFakeTimers();
    const armDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (typeof timeout === "number") {
        armDelays.push(timeout);
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);

    const gate = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<string>();
    const request = withTimeout(
      async () => {
        await gate.promise;
        return waitForBrowserStartup(() => ready.promise);
      },
      20_000,
      "browser request",
    );
    const result = request.catch((error: unknown) => error);

    // Initial arm records `startedAt`.
    await vi.advanceTimersByTimeAsync(0);
    // Wall clock jumps forward 30s while the monotonic clock stands still
    // (vi.setSystemTime only moves Date, not performance.now()).
    vi.setSystemTime(Date.now() + 30_000);
    gate.resolve();
    // pause() deducts `now - startedAt` from the remaining budget.
    await vi.advanceTimersByTimeAsync(0);
    // resume() re-arms the timer with the remaining budget.
    ready.resolve("ready");
    await vi.advanceTimersByTimeAsync(0);

    expect(await result).toBe("ready");
    // The resume re-arm must keep the original ~20s budget. A wall-clock-only
    // jump must not collapse it to the 1ms floor (which would kill a healthy
    // request right after resume).
    const lastArm = armDelays[armDelays.length - 1];
    expect(lastArm).toBeGreaterThan(10_000);
  });
});
