import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createMemorySearchDeadlineControl,
  type MemorySearchDeadlineControl,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider, EmbeddingProviderRuntime } from "./embeddings.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";

type EmbeddingQueryRetryHarness = {
  provider: EmbeddingProvider;
  embedQueryWithRetry: (
    text: string,
    signal?: AbortSignal,
    provider?: EmbeddingProvider,
    markDegraded?: boolean,
    providerRuntime?: EmbeddingProviderRuntime,
    deadlineControl?: MemorySearchDeadlineControl,
  ) => Promise<number[]>;
  markLocalEmbeddingProviderDegraded: (error: unknown) => void;
  resolveEmbeddingTimeout: () => number;
  withProviderUse: <T>(provider: EmbeddingProvider, run: () => Promise<T>) => Promise<T>;
};

function createEmbeddingQueryRetryHarness(
  embedQuery: EmbeddingProvider["embed"],
  timeoutMs = 60_000,
): EmbeddingQueryRetryHarness {
  const provider: EmbeddingProvider = {
    id: "test-provider",
    model: "test-embedding-model",
    embed: embedQuery,
    embedBatch: async () => [],
  };

  // Exercise the real query and retry methods without opening an unrelated
  // memory index or acquiring an external embedding provider.
  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider,
    resolveEmbeddingTimeout: () => timeoutMs,
    markLocalEmbeddingProviderDegraded: vi.fn(),
    withProviderUse: async <T>(_provider: EmbeddingProvider, run: () => Promise<T>) => await run(),
  }) as EmbeddingQueryRetryHarness;
}

function createEmbeddingBatchRetryHarness(embedBatch: EmbeddingProvider["embedBatch"]) {
  const manager = Object.assign(
    createEmbeddingQueryRetryHarness(async () => []),
    {
      waitForEmbeddingRetry: vi.fn(async () => {}),
    },
  ) as EmbeddingQueryRetryHarness & {
    embedBatchWithRetry: (
      inputs: Parameters<EmbeddingProvider["embedBatch"]>[0],
    ) => Promise<number[][]>;
    waitForEmbeddingRetry: ReturnType<typeof vi.fn>;
  };
  manager.provider.embedBatch = embedBatch;
  return manager;
}

type EmbeddingTimeoutHarness = {
  provider: EmbeddingProvider;
  settings: { sync: { embeddingTimeoutSeconds: number | undefined } };
  providerRuntime: EmbeddingProviderRuntime | undefined;
  resolveEmbeddingTimeout: (kind: "query" | "batch") => number;
  embedBatchWithRetry: (inputs: Array<string | { text: string }>) => Promise<number[][]>;
  markLocalEmbeddingProviderDegraded: ReturnType<typeof vi.fn>;
  waitForEmbeddingRetry: ReturnType<typeof vi.fn>;
};

/** Exercise the real timeout resolution and watchdog path with a fake slow provider. */
function createEmbeddingTimeoutHarness(params: {
  embedBatch: EmbeddingProvider["embedBatch"];
  embeddingTimeoutSeconds?: number;
  providerRuntime?: EmbeddingProviderRuntime;
}): EmbeddingTimeoutHarness {
  const provider: EmbeddingProvider = {
    id: "local",
    model: "embeddinggemma-300m-qat-q8_0",
    embed: async () => [],
    embedBatch: params.embedBatch,
  };
  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider,
    settings: { sync: { embeddingTimeoutSeconds: params.embeddingTimeoutSeconds } },
    providerRuntime: params.providerRuntime,
    markLocalEmbeddingProviderDegraded: vi.fn(),
    waitForEmbeddingRetry: vi.fn(async () => {}),
    withProviderUse: async <T>(_provider: EmbeddingProvider, run: () => Promise<T>) => await run(),
  }) as EmbeddingTimeoutHarness;
}

function stalledEmbeddingBatch(calls: Array<AbortSignal | undefined> = []) {
  return async (
    _inputs: Parameters<EmbeddingProvider["embedBatch"]>[0],
    options?: Parameters<EmbeddingProvider["embedBatch"]>[1],
  ) => {
    calls.push(options?.signal);
    // Stand in for a saturated single-core llama.cpp server: the request is
    // healthy but needs far longer than the watchdog budget.
    return await new Promise<number[][]>(() => {});
  };
}

describe("memory embedding query retry cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for an already-active readiness phase before arming its query deadline", async () => {
    vi.useFakeTimers();
    const control = createMemorySearchDeadlineControl();
    control.report("pause");
    const ready = createDeferred<void>();
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>(async () => {
      await ready.promise;
      return [1, 0, 0, 0];
    });
    const manager = createEmbeddingQueryRetryHarness(embedQuery);
    const pending = manager.embedQueryWithRetry(
      "search terms",
      undefined,
      undefined,
      true,
      undefined,
      control,
    );
    void pending.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(70_000);
      expect(embedQuery).toHaveBeenCalledOnce();
      expect(embedQuery.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      control.report("resume");
      ready.resolve();
      await expect(pending).resolves.toEqual([1, 0, 0, 0]);
    } finally {
      ready.resolve();
      await vi.runAllTimersAsync();
      await pending.catch(() => {});
    }
  });

  it("cancels provider backoff immediately without sending a second request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortReason = new Error("memory search was cancelled");
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>().mockRejectedValue(
      Object.assign(new Error("gemini embeddings failed (429)"), {
        status: 429,
        retryAfterMs: 60_000,
      }),
    );
    const manager = createEmbeddingQueryRetryHarness(embedQuery, 10_000);
    const waitForRetrySpy = vi.spyOn(
      manager as unknown as {
        waitForEmbeddingRetry: (
          delayMs: number,
          action: string,
          signal?: AbortSignal,
        ) => Promise<void>;
      },
      "waitForEmbeddingRetry",
    );

    const pending = manager.embedQueryWithRetry("search terms", controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(embedQuery).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    const firstDelayMs = waitForRetrySpy.mock.calls[0]?.[0];
    expect(firstDelayMs).toBeGreaterThanOrEqual(6400);
    expect(firstDelayMs).toBeLessThanOrEqual(8000);

    controller.abort(abortReason);

    await expect(pending).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
      cause: { message: "aborted", cause: abortReason },
    });
    expect(embedQuery).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a provider request for an already-cancelled search", async () => {
    const abortReason = new Error("memory search was cancelled");
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>();
    const manager = createEmbeddingQueryRetryHarness(embedQuery);

    await expect(
      manager.embedQueryWithRetry("search terms", AbortSignal.abort(abortReason)),
    ).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
      cause: abortReason,
    });
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("reaches caller fallback within the memory_search deadline after a hinted 429", async () => {
    vi.useFakeTimers();
    const waits: number[] = [];
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>().mockRejectedValue(
      Object.assign(new Error("gemini embeddings failed (429)"), {
        status: 429,
        retryAfterMs: 60_000,
      }),
    );
    const manager = Object.assign(createEmbeddingQueryRetryHarness(embedQuery), {
      waitForEmbeddingRetry: async (delayMs: number, _action: string, signal?: AbortSignal) => {
        waits.push(delayMs);
        await sleepWithAbort(delayMs, signal);
      },
    }) as EmbeddingQueryRetryHarness;
    const fallback = vi.fn(async () => [0, 1, 0, 0]);

    const pending = manager.embedQueryWithRetry("search terms").catch(fallback);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual([0, 1, 0, 0]);
    expect(embedQuery).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledOnce();
    expect(waits.every((delayMs) => delayMs <= 8_000)).toBe(true);
    expect(waits.reduce((total, delayMs) => total + delayMs, 0)).toBeLessThan(15_000);
  });

  it("retries provider success that arrives after each embedding deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const operationSignals: AbortSignal[] = [];
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>(async (_input, options) => {
      if (options?.signal) {
        operationSignals.push(options.signal);
      }
      vi.setSystemTime(Date.now() + 11);
      return [1, 0, 0, 0];
    });
    const manager = createEmbeddingQueryRetryHarness(embedQuery, 10);
    const pending = manager.embedQueryWithRetry("search terms");
    void pending.catch(() => {});

    await vi.runAllTimersAsync();

    const timeoutMessage =
      "memory embeddings query timed out after 0s (provider=test-provider, model=test-embedding-model)";
    await expect(pending).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "query",
      cause: { message: timeoutMessage },
    });
    expect(embedQuery).toHaveBeenCalledTimes(3);
    expect(operationSignals).toHaveLength(3);
    expect(operationSignals.every((signal) => signal.aborted)).toBe(true);
    expect(operationSignals.every((signal) => signal.reason?.message === timeoutMessage)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(["text", "structured"])("memory embedding batch retry boundary (%s)", (kind) => {
  const batchInputs = (texts: string[]) =>
    kind === "text" ? texts : texts.map((text) => ({ text }));
  it.each([
    [
      "explicit maximum and actual input counts",
      (count: number) =>
        `Embeddings API input limit exceeded: max 10, got ${count}. Request id: fixture-000597000`,
    ],
    ["an explicit maximum input length", () => "embeddings max input length is 10"],
    [
      "a DashScope-style per-request row cap",
      () =>
        '{"error":{"message":"<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, it should not be larger than 10.: input.contents","type":"InvalidParameter","code":"InvalidParameter"}}',
    ],
  ])(
    "splits provider errors with %s without retrying oversized requests",
    async (_label, error) => {
      const items = Array.from({ length: 33 }, (_, index) => `item-${index}`);
      const embedBatch = vi.fn<EmbeddingProvider["embedBatch"]>(async (inputs) => {
        const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
        if (texts.length > 10) {
          throw new Error(`openai-compatible embeddings failed: HTTP 400: ${error(texts.length)}`);
        }
        return texts.map((text) => [Number.parseInt(text.slice(5), 10)]);
      });
      const manager = createEmbeddingBatchRetryHarness(embedBatch);

      await expect(manager.embedBatchWithRetry(batchInputs(items))).resolves.toEqual(
        items.map((_, index) => [index]),
      );
      expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([
        33, 17, 9, 8, 16, 8, 8,
      ]);
      expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
      expect(manager.markLocalEmbeddingProviderDegraded).not.toHaveBeenCalled();
    },
  );

  it("sends a batch under the provider row cap in one request", async () => {
    const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
    const embedBatch = vi.fn<EmbeddingProvider["embedBatch"]>(async (inputs) => {
      const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
      if (texts.length > 10) {
        throw new Error(
          'openai-compatible embeddings failed: HTTP 400: {"error":{"message":"<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid, it should not be larger than 10.: input.contents","type":"InvalidParameter","code":"InvalidParameter"}}',
        );
      }
      return texts.map((text) => [Number.parseInt(text.slice(5), 10)]);
    });
    const manager = createEmbeddingBatchRetryHarness(embedBatch);

    await expect(manager.embedBatchWithRetry(batchInputs(items))).resolves.toEqual(
      items.map((_, index) => [index]),
    );
    expect(embedBatch).toHaveBeenCalledOnce();
    expect(embedBatch.mock.calls[0]?.[0]).toHaveLength(10);
    expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "generic validation errors containing request-id digits",
      message:
        '{"error":{"code":"InvalidParameter","message":"The parameter input specified in the request is not valid. Request id: fixture-000597000","param":"input"}}',
      items: ["one", "two"],
    },
    {
      label: "a nonnumeric row cap containing request-id digits",
      message: "batch size is invalid, it should not be larger than unknown; request id 12345",
      items: ["one", "two"],
    },
    {
      label: "a numeric row cap rejecting a single item",
      message: "batch size is invalid, it should not be larger than 10",
      items: ["one"],
    },
  ])("does not retry or split $label", async ({ message, items }) => {
    const embedBatch = vi.fn(async () => {
      throw new Error(`openai-compatible embeddings failed: HTTP 400: ${message}`);
    });
    const manager = createEmbeddingBatchRetryHarness(embedBatch);

    await expect(manager.embedBatchWithRetry(batchInputs(items))).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: kind === "text" ? "batch" : "structured-batch",
    });
    expect(embedBatch).toHaveBeenCalledOnce();
    expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
    expect(manager.markLocalEmbeddingProviderDegraded).toHaveBeenCalledOnce();
  });
});

describe("memory embedding request timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps provider-owned timeouts when no embedding timeout is configured", () => {
    const manager = createEmbeddingTimeoutHarness({
      embedBatch: async () => [],
      providerRuntime: {
        id: "local",
        inlineQueryTimeoutMs: 300_000,
        inlineBatchTimeoutMs: 600_000,
      },
    });

    expect(manager.resolveEmbeddingTimeout("query")).toBe(300_000);
    expect(manager.resolveEmbeddingTimeout("batch")).toBe(600_000);
  });

  it("overrides provider-owned query and batch timeouts with the configured value", () => {
    const manager = createEmbeddingTimeoutHarness({
      embedBatch: async () => [],
      embeddingTimeoutSeconds: 45,
      providerRuntime: {
        id: "local",
        inlineQueryTimeoutMs: 300_000,
        inlineBatchTimeoutMs: 600_000,
      },
    });

    expect(manager.resolveEmbeddingTimeout("query")).toBe(45_000);
    expect(manager.resolveEmbeddingTimeout("batch")).toBe(45_000);
  });

  it("aborts a stalled embedding batch at the configured timeout and names the request", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    const manager = createEmbeddingTimeoutHarness({
      embedBatch: stalledEmbeddingBatch(signals),
      embeddingTimeoutSeconds: 1,
      providerRuntime: { id: "local", inlineBatchTimeoutMs: 600_000 },
    });

    const pending = manager.embedBatchWithRetry(["slow chunk"]);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: "batch",
      providerId: "local",
      cause: {
        message:
          "memory embeddings batch timed out after 1s (provider=local, model=embeddinggemma-300m-qat-q8_0, items=1)",
      },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(manager.markLocalEmbeddingProviderDegraded).toHaveBeenCalledOnce();
  });

  it("splits a timed-out batch instead of resending the oversized request", async () => {
    vi.useFakeTimers();
    const batchSizes: number[] = [];
    const manager = createEmbeddingTimeoutHarness({
      embedBatch: async (inputs) => {
        const texts = inputs.map((input) => (typeof input === "string" ? input : input.text));
        batchSizes.push(texts.length);
        if (texts.length > 1) {
          return await new Promise<number[][]>(() => {});
        }
        return texts.map((text) => [text.length]);
      },
      embeddingTimeoutSeconds: 1,
      providerRuntime: { id: "local", inlineBatchTimeoutMs: 600_000 },
    });

    const pending = manager.embedBatchWithRetry(["first", "second"]);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual([[5], [6]]);
    // One stalled oversized request, then two half-size requests that converge.
    expect(batchSizes).toEqual([2, 1, 1]);
  });
});
