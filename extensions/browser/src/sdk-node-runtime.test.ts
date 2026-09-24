// Browser tests cover sdk node runtime plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "./sdk-node-runtime.js";

describe("withTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
});
