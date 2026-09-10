import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { attemptMemoryCorpus, runMemoryCorpusDeadline } from "./memory-corpus.js";
import { runWithMemorySearchDeadlineSuspended } from "./memory/search-deadline.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["timer", "event-loop"] as const)(
  "retains completed results when the %s reaches the corpus deadline",
  async (clock) => {
    vi.useFakeTimers();
    const pending = createDeferred<string[]>();
    const partial = ["permitted keyword match"];
    const startedAt = performance.now();
    let signal: AbortSignal | undefined;
    const result = runMemoryCorpusDeadline({
      operation: "memory_search",
      run: async (currentSignal) => {
        signal = currentSignal;
        return await attemptMemoryCorpus({
          corpus: "memory",
          signal: currentSignal,
          unavailableValue: [],
          getPartialValue: () => partial,
          run: () => pending.promise,
        });
      },
    });
    if (clock === "timer") {
      await vi.advanceTimersByTimeAsync(15_000);
    } else {
      vi.spyOn(performance, "now").mockReturnValue(startedAt + 15_001);
      pending.resolve(["late semantic result"]);
    }
    expect(await result).toMatchObject({
      outcome: "partial",
      value: partial,
      deadline: true,
      error: "memory_search timed out after 15s",
    });
    expect(signal?.aborted).toBe(true);
    pending.resolve([]);
  },
);

it.each(["provider", "caller"] as const)(
  "does not replace a %s failure with partial results",
  async (source) => {
    const parent = new AbortController();
    const failure = new Error("memory_search timed out after 15s");
    const result = runMemoryCorpusDeadline({
      operation: "memory_search",
      parentSignal: parent.signal,
      run: async (signal) =>
        await attemptMemoryCorpus({
          corpus: "memory",
          signal,
          unavailableValue: [],
          getPartialValue: () => ["keyword match"],
          run: async () => {
            if (source === "caller") {
              parent.abort(failure);
            }
            throw failure;
          },
        }),
    });
    if (source === "caller") {
      await expect(result).rejects.toBe(failure);
    } else {
      expect(await result).toMatchObject({ outcome: "unavailable", value: [], deadline: false });
    }
  },
);

it("excludes managed service acquisition from the memory_search corpus deadline", async () => {
  vi.useFakeTimers();
  const startup = createDeferred<void>();
  const search = createDeferred<string>();
  const result = runMemoryCorpusDeadline({
    operation: "memory_search",
    run: async () => {
      await runWithMemorySearchDeadlineSuspended(() => startup.promise);
      return await search.promise;
    },
  });
  const resultAssertion = expect(result).resolves.toBe("found");
  await Promise.resolve();

  await vi.advanceTimersByTimeAsync(30_000);
  expect(vi.getTimerCount()).toBe(0);
  startup.resolve();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  search.resolve("found");

  await resultAssertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves caller cancellation during suspended memory_search acquisition", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const reason = new Error("agent run cancelled during service startup");
  const result = runMemoryCorpusDeadline({
    operation: "memory_search",
    parentSignal: parent.signal,
    run: async () =>
      await runWithMemorySearchDeadlineSuspended(async () => await new Promise(() => {})),
  });
  const resultAssertion = expect(result).rejects.toBe(reason);
  await Promise.resolve();

  parent.abort(reason);

  await resultAssertion;
  expect(vi.getTimerCount()).toBe(0);
});

it("does not suspend the memory_get corpus deadline", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<string>();
  const result = runMemoryCorpusDeadline({
    operation: "memory_get",
    run: async (signal) =>
      await runWithMemorySearchDeadlineSuspended(
        async () =>
          await attemptMemoryCorpus({
            corpus: "memory",
            signal,
            unavailableValue: "",
            run: () => pending.promise,
          }),
      ),
  });

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(result).resolves.toMatchObject({
    outcome: "unavailable",
    deadline: true,
    error: "memory_get timed out after 15s",
  });
  expect(vi.getTimerCount()).toBe(0);
});
