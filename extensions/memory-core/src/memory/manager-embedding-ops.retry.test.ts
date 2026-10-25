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
    providerRuntime?: EmbeddingProviderRuntime,
    deadlineControl?: MemorySearchDeadlineControl,
  ) => Promise<number[]>;
  markLocalEmbeddingProviderDegraded: (error: unknown) => void;
  resolveEmbeddingTimeout: () => number;
  waitForEmbeddingRetry: (delayMs: number, action: string, signal?: AbortSignal) => Promise<void>;
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

  return Object.assign(Object.create(MemoryManagerEmbeddingOps.prototype), {
    provider,
    settings: {},
    resolveEmbeddingTimeout: () => timeoutMs,
    markLocalEmbeddingProviderDegraded: vi.fn(),
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

const rateLimitError = () =>
  Object.assign(new Error("gemini embeddings failed (429)"), { status: 429, retryAfterMs: 60_000 });

const documentInput = () => ({
  text: "first second",
  parts: [
    { type: "text" as const, text: "first" },
    { type: "text" as const, text: " second" },
  ],
});

describe("memory model input formatting", () => {
  it.each<[string, string, boolean, string?]>([
    [
      "local",
      "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
      true,
    ],
    ["ollama", "embeddinggemma:latest", true],
    ["ollama", "embeddinggemma-2:270m", true],
    ["lmstudio", "text-embedding-embeddinggemma-300m", true],
    ["openai-compatible", "google/embeddinggemma-300m", true],
    ["local", "/models/EmbeddingGemma-300m.Q8_0.gguf", true],
    ["openai-compatible", "nomic-embed-text", false],
    ["openai-compatible", "other/embeddinggemmax", false],
    ["gemini", "gemini-embedding-2", false],
    ["local", "embeddinggemma", true, "custom: "],
  ])(
    "formats query and document inputs for %s/%s",
    async (id, model, prefixed, queryInstruction) => {
      const embed = vi.fn<EmbeddingProvider["embed"]>(async () => [1, 0]);
      const embedBatch = vi.fn<EmbeddingProvider["embedBatch"]>(async (inputs) =>
        inputs.map(() => [0, 1]),
      );
      const manager = createEmbeddingBatchRetryHarness(embedBatch);
      Object.assign(manager.provider, { id, model, embed });
      Object.assign(manager, { settings: { queryInstruction } });
      const document = documentInput();

      await expect(manager.embedQueryWithRetry("find this")).resolves.toEqual([1, 0]);
      await expect(manager.embedBatchWithRetry(["remember this", document])).resolves.toEqual([
        [0, 1],
        [0, 1],
      ]);

      expect(embed.mock.calls[0]?.[0]).toBe(
        queryInstruction
          ? `${queryInstruction}find this`
          : prefixed
            ? "task: search result | query: find this"
            : "find this",
      );
      expect(embed.mock.calls[0]?.[1]?.queryInstructionApplied).toBe(
        queryInstruction ? true : undefined,
      );
      expect(embedBatch.mock.calls[0]?.[0]).toEqual(
        prefixed
          ? [
              "title: none | text: remember this",
              {
                text: "title: none | text: first second",
                parts: [
                  { type: "text", text: "title: none | text: first" },
                  { type: "text", text: " second" },
                ],
              },
            ]
          : ["remember this", document],
      );
      expect(document).toEqual(documentInput());
    },
  );
});

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
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>().mockRejectedValue(rateLimitError());
    const manager = createEmbeddingQueryRetryHarness(embedQuery, 10_000);
    const waitForRetrySpy = vi.spyOn(manager, "waitForEmbeddingRetry");

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
    const embedQuery = vi.fn<EmbeddingProvider["embed"]>().mockRejectedValue(rateLimitError());
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

    const timeoutMessage = "memory embeddings query timed out after 0s";
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
  it("splits a provider row-cap error without retrying oversized requests", async () => {
    const items = Array.from({ length: 33 }, (_, index) => `item-${index}`);
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
    expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([33, 10, 10, 10, 3]);
    expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
    expect(manager.markLocalEmbeddingProviderDegraded).not.toHaveBeenCalled();
  });

  it.each([
    [
      '{"error":{"code":"InvalidParameter","message":"The parameter input specified in the request is not valid. Request id: fixture-000597000","param":"input"}}',
      ["one", "two"],
    ],
    ["batch size is invalid, it should not be larger than 10", ["one"]],
  ] satisfies [string, string[]][])("does not retry or split %s", async (message, items) => {
    const embedBatch = vi.fn<EmbeddingProvider["embedBatch"]>(async () => {
      throw new Error(`openai-compatible embeddings failed: HTTP 400: ${message}`);
    });
    const manager = createEmbeddingBatchRetryHarness(embedBatch);

    await expect(manager.embedBatchWithRetry(batchInputs(items))).rejects.toMatchObject({
      code: "MEMORY_EMBEDDING_OPERATION_FAILED",
      operation: kind === "text" ? "batch" : "structured-batch",
    });
    expect(embedBatch).toHaveBeenCalledOnce();
    expect(embedBatch.mock.calls[0]?.[0]).toEqual(batchInputs(items));
    expect(manager.waitForEmbeddingRetry).not.toHaveBeenCalled();
    expect(manager.markLocalEmbeddingProviderDegraded).toHaveBeenCalledOnce();
  });
});
