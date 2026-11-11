import { AsyncWorkScope, createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const embeddings = await import("./embeddings.js");
const fixture = createManagerIndexFixture(await import("./index.js"));

it.each([
  ["openai", 60_000, undefined, false, false],
  ["local", 300_000, undefined, false, false],
  ["openai", 90_000, 90_000, false, false],
  ["openai", 60_000, undefined, true, false],
  ["local", 300_000, undefined, false, true],
] as const)(
  "probe %s: %i ms, override=%s, pause=%s, cancel=%s",
  async (id, timeoutMs, override, pause, cancel) => {
    const model = id === "local" ? "embeddinggemma" : "mock-embed";
    const failure = new Error("caller cancelled the read");
    const entered = createDeferred<Parameters<MemoryEmbeddingProvider["embed"]>[1]>();
    const completion = createDeferred<number[]>();
    const embed = vi.fn<MemoryEmbeddingProvider["embed"]>(async (_input, options) => {
      entered.resolve(options);
      if (cancel) {
        return await new Promise<number[]>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(failure), {
            once: true,
          });
        });
      }
      return await completion.promise;
    });
    const create = vi.spyOn(embeddings, "createEmbeddingProvider").mockResolvedValueOnce({
      requestedProvider: id,
      provider: {
        id,
        model,
        embed,
        embedBatch: (inputs, options) => Promise.all(inputs.map((input) => embed(input, options))),
        close: vi.fn(async () => {}),
      },
      runtime: { id, inlineQueryTimeoutMs: override },
    });
    const cfg = fixture.createConfig({ provider: id, model });
    const manager = await fixture.getFreshManager(cfg, "status");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scope = new AsyncWorkScope();
    const probe = scope.run(() => manager.probeEmbeddingAvailability());
    const options = await entered.promise;
    create.mockRestore();
    try {
      if (cancel) {
        scope.beginClose(failure);
        await expect(probe).rejects.toBe(failure);
        expect(options?.signal?.aborted).toBe(true);
        expect(manager.getCachedEmbeddingAvailability()).toBeNull();
        expect(manager.status().provider).toBe("local");
      } else if (pause) {
        const control = options?.[MEMORY_SEARCH_DEADLINE_CONTROL];
        expect(control).toBeDefined();
        control?.report("pause");
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(options?.signal?.aborted).toBe(false);
        control?.report("resume");
        await vi.advanceTimersByTimeAsync(45_000);
        expect(options?.signal?.aborted).toBe(false);
        completion.resolve([1, 0]);
        await expect(probe).resolves.toEqual({ ok: true });
        expect(vi.getTimerCount()).toBe(0);
      } else {
        await vi.advanceTimersByTimeAsync(timeoutMs - 1);
        expect(options?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(options?.signal?.aborted).toBe(true);
        await expect(probe).resolves.toEqual({
          ok: false,
          error: `memory embedding probe timed out after ${timeoutMs / 1000}s`,
        });
        await expect(manager.probeEmbeddingAvailability()).resolves.toMatchObject({
          ok: false,
          cached: true,
        });
        expect(embed.mock.calls[0]?.[0]).toBe(
          id === "local" ? "task: search result | query: ping" : "ping",
        );
      }
      expect(embed).toHaveBeenCalledTimes(1);
    } finally {
      completion.resolve([1, 0]);
      await probe.catch(() => undefined);
    }
  },
);

it.each(["initialization", "probe"])(
  "keeps another caller alive during cancelled %s",
  async (phase) => {
    const failure = new Error("cancel only this diagnostic");
    const initialization = createDeferred();
    const entered = createDeferred();
    const completion = createDeferred();
    fixture.provider.providerInitGate = initialization.promise;
    let queries = 0;
    fixture.provider.beforeEmbedQuery = async (options) => {
      if (++queries === (phase === "probe" ? 2 : 1)) {
        entered.resolve();
      }
      await new Promise<void>((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(failure), {
          once: true,
        });
        void completion.promise.then(resolve, reject);
      });
    };
    const manager = await fixture.getFreshManager(fixture.createConfig({}), "status");
    const scope = new AsyncWorkScope();
    const cancelled = scope.run(() => manager.probeEmbeddingAvailability());
    const rejected = expect(cancelled).rejects.toBe(failure);
    const surviving = manager.probeEmbeddingAvailability();
    if (phase === "initialization") {
      scope.beginClose(failure);
    }
    initialization.resolve();
    try {
      await entered.promise;
      if (phase === "probe") {
        scope.beginClose(failure);
      }
      await rejected;
      expect(manager.getCachedEmbeddingAvailability()).toBeNull();
      expect(fixture.provider.providerCalls).toHaveLength(1);
      completion.resolve();
      await expect(surviving).resolves.toEqual({ ok: true });
      expect(manager.getCachedEmbeddingAvailability()).toMatchObject({ ok: true });
      expect(fixture.provider.embedQueryCalls).toBe(1);
    } finally {
      initialization.resolve();
      completion.resolve();
      await Promise.allSettled([cancelled, surviving]);
    }
  },
);
