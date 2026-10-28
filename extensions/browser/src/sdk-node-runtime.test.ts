import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForBrowserStartup, withTimeout } from "./sdk-node-runtime.js";

describe("withTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps nested paused budgets monotonic across a wall-clock step", async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<string>();
    const finish = Promise.withResolvers<string>();
    async function work(signal?: AbortSignal): Promise<string> {
      await gate.promise;
      await waitForBrowserStartup(() => ready.promise);
      return new Promise<string>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
        void finish.promise.then(resolve);
      });
    }
    const request = () => withTimeout(work, 20_000);
    const result = withTimeout(request, 20_000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 30_000);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    ready.resolve("ready");
    await vi.advanceTimersByTimeAsync(1);
    finish.resolve("ok");
    expect(await result).toBe("ok");
  });

  it("rejects the deadline when work resolves while handling cancellation", async () => {
    vi.useFakeTimers();
    let workSignal: AbortSignal | undefined;
    const work2 = (signal?: AbortSignal) => {
      workSignal = signal;
      return new Promise<string>((resolve) => {
        signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      });
    };
    const pending = withTimeout(work2, 100, "browser request");
    const rejected = expect(pending).rejects.toThrow("browser request timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(workSignal?.aborted).toBe(true);
  });

  it("caps oversized timeouts before arming the abort timer", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await expect(withTimeout(async () => "ok", Number.MAX_SAFE_INTEGER)).resolves.toBe("ok");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
