import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attemptMemoryCorpus, runMemoryCorpusDeadline } from "./memory-corpus.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const search = <T>(
  run: Parameters<typeof runMemoryCorpusDeadline<T>>[0]["run"],
  parentSignal?: AbortSignal,
) => runMemoryCorpusDeadline({ operation: "memory_search", parentSignal, run });

it.each(["timer", "event-loop"] as const)(
  "retains completed results when the %s reaches the corpus deadline",
  async (clock) => {
    const pending = createDeferred<string[]>();
    const partial = ["permitted keyword match"];
    const startedAt = performance.now();
    let signal: AbortSignal | undefined;
    const result = search((current) => {
      signal = current;
      return attemptMemoryCorpus({
        signal: current,
        getPartialValue: () => partial,
        run: () => pending.promise,
      });
    });
    if (clock === "timer") {
      await vi.advanceTimersByTimeAsync(30_000);
    } else {
      vi.spyOn(performance, "now").mockReturnValue(startedAt + 30_001);
      pending.resolve(["late semantic result"]);
    }
    expect(await result).toMatchObject({
      outcome: "partial",
      value: partial,
      deadline: true,
      error: "memory_search timed out after 30s",
    });
    expect(signal?.aborted).toBe(true);
    pending.resolve([]);
  },
);

it("does not replace a caller failure with partial results", async () => {
  const parent = new AbortController();
  const failure = new Error("memory_search timed out after 30s");
  const result = search(
    (signal) =>
      attemptMemoryCorpus({
        signal,
        getPartialValue: () => ["keyword match"],
        run: async () => {
          parent.abort(failure);
          throw failure;
        },
      }),
    parent.signal,
  );
  await expect(result).rejects.toBe(failure);
});

it("re-arms the banked budget when an owned phase completes", async () => {
  const result = search(async (signal, control) => {
    await vi.advanceTimersByTimeAsync(5_000);
    control.report("pause");
    await vi.advanceTimersByTimeAsync(60_000);
    control.report("resume");
    // Only the 25s banked before the pause remains for post-readiness work.
    await vi.advanceTimersByTimeAsync(24_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal.aborted).toBe(true);
    signal.throwIfAborted();
  });
  await expect(result).rejects.toThrow("memory_search timed out after 30s");
});

it("expires immediately when the budget is already consumed at pause time", async () => {
  const startedAt = performance.now();
  const result = search(async (signal, control) => {
    // The overdue timer may not be serviced yet when the owned phase starts.
    vi.spyOn(performance, "now").mockReturnValue(startedAt + 30_000);
    control.report("pause");
    expect(signal.aborted).toBe(true);
    signal.throwIfAborted();
  });
  await expect(result).rejects.toThrow("memory_search timed out after 30s");
});

it("keeps caller cancellation immediate while the deadline is paused", async () => {
  const parent = new AbortController();
  const callerError = new Error("caller cancelled");
  const result = search(async (signal, control) => {
    control.report("pause");
    await vi.advanceTimersByTimeAsync(60_000);
    parent.abort(callerError);
    signal.throwIfAborted();
  }, parent.signal);
  await expect(result).rejects.toBe(callerError);
});
