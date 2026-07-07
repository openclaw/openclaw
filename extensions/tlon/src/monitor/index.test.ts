// Tlon monitor tests cover retry cleanup behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForTlonAuthRetryDelay } from "./index.js";

describe("waitForTlonAuthRetryDelay", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("removes the abort listener after the retry delay resolves", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    const pending = waitForTlonAuthRetryDelay(1000, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBeUndefined();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the retry timer when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    const pending = waitForTlonAuthRetryDelay(1000, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("Aborted");
    expect(vi.getTimerCount()).toBe(0);
  });
});
