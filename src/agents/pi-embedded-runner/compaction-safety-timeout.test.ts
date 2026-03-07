import { describe, expect, it } from "vitest";
import { compactWithSafetyTimeout } from "./compaction-safety-timeout.js";

describe("compactWithSafetyTimeout", () => {
  it("resolves normally when work completes in time", async () => {
    const result = await compactWithSafetyTimeout(async () => "done", 5000);
    expect(result).toBe("done");
  });

  it("rejects with timeout error when work exceeds timeout", async () => {
    await expect(
      compactWithSafetyTimeout(() => new Promise((resolve) => setTimeout(resolve, 5000)), 50),
    ).rejects.toThrow(/timed out/i);
  });

  it("aborts immediately when external signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled externally"));

    await expect(
      compactWithSafetyTimeout(
        async (signal) => {
          // Signal should be aborted
          if (signal?.aborted) {
            throw signal.reason;
          }
          return "should not reach";
        },
        5000,
        ctrl.signal,
      ),
    ).rejects.toThrow(/cancelled externally/);
  });

  it("aborts when external signal fires during work", async () => {
    const ctrl = new AbortController();

    const workPromise = compactWithSafetyTimeout(
      (signal) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
          // Work that would take too long
          setTimeout(resolve, 10_000);
        }),
      5000,
      ctrl.signal,
    );

    // Abort externally after 50ms
    setTimeout(() => ctrl.abort(new Error("run cancelled")), 50);

    await expect(workPromise).rejects.toThrow(/run cancelled/);
  });

  it("passes merged signal to work function", async () => {
    let receivedSignal: AbortSignal | undefined;
    await compactWithSafetyTimeout(async (signal) => {
      receivedSignal = signal;
      return "ok";
    }, 5000);
    // Should receive a signal from the timeout mechanism
    expect(receivedSignal).toBeDefined();
  });
});
