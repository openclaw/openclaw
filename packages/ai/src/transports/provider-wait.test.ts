import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderWaitObserver } from "./provider-wait.js";

afterEach(() => vi.useRealTimers());

describe("provider wait observation", () => {
  it("reports a held response once and clears on first progress", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const wait = createProviderWaitObserver({ onProviderWait: notify });
    wait.start();
    vi.advanceTimersByTime(999);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["response"]]);
    wait.stop();
    wait.stop();
    vi.advanceTimersByTime(10_000);
    expect(notify.mock.calls).toEqual([["response"], [null]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves evidence-backed slot wording and clears synchronously on cancellation", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const controller = new AbortController();
    const wait = createProviderWaitObserver({
      onProviderWait: notify,
      signal: controller.signal,
    });
    wait.start();
    wait.report("slot");
    wait.report("slot");
    vi.advanceTimersByTime(1_000);
    expect(notify.mock.calls).toEqual([["slot"]]);
    controller.abort();
    wait.report("response");
    expect(notify.mock.calls).toEqual([["slot"], [null]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not flash a wait for a fast response or retain cancellation listeners", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const wait = createProviderWaitObserver({ onProviderWait: notify, signal: controller.signal });
    wait.start();
    wait.stop();
    controller.abort();
    vi.advanceTimersByTime(1_000);
    expect(notify).not.toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does no timer work without an observer or after cancellation", () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    createProviderWaitObserver(undefined).start();
    createProviderWaitObserver({ onProviderWait: notify, signal: AbortSignal.abort() }).start();
    expect(vi.getTimerCount()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
