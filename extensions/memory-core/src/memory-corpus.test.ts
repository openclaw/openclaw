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
const partial = ["keyword match"];
const attempt = (signal: AbortSignal, run: () => Promise<string[]>) =>
  attemptMemoryCorpus({ signal, getPartialValue: () => partial, run });

it.each(["timer", "event-loop"] as const)(
  "retains completed results when the %s reaches the corpus deadline",
  async (clock) => {
    const pending = createDeferred<string[]>();
    const startedAt = performance.now();
    let signal: AbortSignal | undefined;
    const result = search((current) => {
      signal = current;
      return attempt(current, () => pending.promise);
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
      attempt(signal, async () => {
        parent.abort(failure);
        throw failure;
      }),
    parent.signal,
  );
  await expect(result).rejects.toBe(failure);
});

it.each(["banked", "consumed"])("preserves the %s budget across a pause", async (budget) => {
  const startedAt = performance.now();
  const result = search(async (signal, control) => {
    if (budget === "consumed") {
      // The overdue timer has not been serviced when the owned phase starts.
      vi.spyOn(performance, "now").mockReturnValue(startedAt + 30_000);
    } else {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    control.report("pause");
    if (budget === "banked") {
      await vi.advanceTimersByTimeAsync(60_000);
      control.report("resume");
      await vi.advanceTimersByTimeAsync(24_999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
    }
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
