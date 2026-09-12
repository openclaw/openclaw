import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  attemptMemoryCorpus,
  runMemoryCorpusDeadline,
  searchMemoryCorpusSupplements,
  readMemoryCorpusSupplements,
} from "./memory-corpus.js";

afterEach(() => {
  clearMemoryPluginState();
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

it("exempts a paused owned phase from the corpus deadline", async () => {
  vi.useFakeTimers();
  const result = await runMemoryCorpusDeadline({
    operation: "memory_search",
    run: async (signal, control) => {
      control.report("pause");
      // A managed local service may take longer than the whole-search budget to
      // become ready; that wait is owned by localService.readyTimeoutMs.
      await vi.advanceTimersByTimeAsync(60_000);
      control.report("resume");
      expect(signal.aborted).toBe(false);
      return "ok";
    },
  });
  expect(result).toBe("ok");
});

it("re-arms the banked budget when an owned phase completes", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const result = runMemoryCorpusDeadline({
    operation: "memory_search",
    run: async (currentSignal, control) => {
      signal = currentSignal;
      await vi.advanceTimersByTimeAsync(5_000);
      control.report("pause");
      await vi.advanceTimersByTimeAsync(60_000);
      control.report("resume");
      // Only the 10s banked before the pause remains for post-readiness work.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(currentSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      currentSignal.throwIfAborted();
      return "late";
    },
  });
  await expect(result).rejects.toThrow("memory_search timed out after 15s");
  expect(signal?.aborted).toBe(true);
});

it("expires immediately when the budget is already consumed at pause time", async () => {
  vi.useFakeTimers();
  const startedAt = performance.now();
  let signal: AbortSignal | undefined;
  const result = runMemoryCorpusDeadline({
    operation: "memory_search",
    run: async (currentSignal, control) => {
      signal = currentSignal;
      // The overdue timer may not be serviced yet when the owned phase starts.
      vi.spyOn(performance, "now").mockReturnValue(startedAt + 15_000);
      control.report("pause");
      currentSignal.throwIfAborted();
      return "unreachable";
    },
  });
  await expect(result).rejects.toThrow("memory_search timed out after 15s");
  expect(signal?.aborted).toBe(true);
});

it("keeps caller cancellation immediate while the deadline is paused", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const callerError = new Error("caller cancelled");
  const result = runMemoryCorpusDeadline({
    operation: "memory_search",
    parentSignal: parent.signal,
    run: async (signal, control) => {
      control.report("pause");
      await vi.advanceTimersByTimeAsync(60_000);
      parent.abort(callerError);
      signal.throwIfAborted();
      return "unreachable";
    },
  });
  await expect(result).rejects.toBe(callerError);
});

it("passes search cancellation separately from strictly validated plugin input", async () => {
  const controller = new AbortController();
  const schema = z.object({ query: z.string(), maxResults: z.number() }).strict();
  const hit = { corpus: "wiki", path: "entities/alpha.md", score: 1, snippet: "Alpha" };
  let receivedSignal: AbortSignal | undefined;
  registerMemoryCorpusSupplement("strict-plugin", {
    search: async (input, context) => {
      schema.parse(input);
      receivedSignal = context?.signal;
      return [hit];
    },
    get: async () => null,
  });
  await expect(
    searchMemoryCorpusSupplements({ query: "alpha", maxResults: 3, signal: controller.signal }),
  ).resolves.toEqual({ corpus: "wiki", outcome: "ok", value: [hit] });
  expect(receivedSignal).toBe(controller.signal);
});

it("passes read cancellation separately from strictly validated plugin input", async () => {
  const controller = new AbortController();
  const schema = z.object({ lookup: z.string() }).strict();
  let receivedSignal: AbortSignal | undefined;
  registerMemoryCorpusSupplement("strict-plugin", {
    search: async () => [],
    get: async (input, context) => {
      schema.parse(input);
      receivedSignal = context?.signal;
      return { corpus: "wiki", path: input.lookup, content: "Alpha", fromLine: 1, lineCount: 1 };
    },
  });
  await expect(
    readMemoryCorpusSupplements({ lookup: "entities/alpha.md", signal: controller.signal }),
  ).resolves.toMatchObject({ outcome: "ok", value: { text: "Alpha" } });
  expect(receivedSignal).toBe(controller.signal);
});

it("does not start queued supplements after cancellation", async () => {
  const controller = new AbortController();
  const started: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    registerMemoryCorpusSupplement(`supplement-${index}`, {
      search: async () => {
        started.push(index);
        controller.abort(new Error("caller cancelled"));
        return [];
      },
      get: async () => null,
    });
  }
  await searchMemoryCorpusSupplements({ query: "alpha", signal: controller.signal });
  expect(started).toEqual([0]);
});
