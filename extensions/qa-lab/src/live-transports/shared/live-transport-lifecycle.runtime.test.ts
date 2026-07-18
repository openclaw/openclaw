import { describe, expect, it, vi } from "vitest";
import {
  createLiveTransportQuiesce,
  runLiveTransportCleanupSteps,
} from "./live-transport-lifecycle.runtime.js";

describe("live transport lifecycle", () => {
  it("stops, drains, and closes once across both cleanup phases", async () => {
    const stopPolling = vi.fn();
    const waitForPolling = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const quiesce = createLiveTransportQuiesce({ close, stopPolling, waitForPolling });

    const first = quiesce();
    const second = quiesce();

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(stopPolling).toHaveBeenCalledOnce();
    expect(waitForPolling).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs every cleanup step and preserves all failures", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("first cleanup failed");
    const secondFailure = new Error("second cleanup failed");

    const cleanup = runLiveTransportCleanupSteps([
      async () => {
        calls.push("first");
        throw firstFailure;
      },
      async () => {
        calls.push("second");
        throw secondFailure;
      },
      async () => {
        calls.push("third");
      },
    ]);

    await expect(cleanup).rejects.toEqual(
      new AggregateError([firstFailure, secondFailure], "live transport cleanup failed"),
    );
    expect(calls).toEqual(["first", "second", "third"]);
  });
});
