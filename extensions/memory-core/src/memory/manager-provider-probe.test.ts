import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const embeddings = await import("./embeddings.js");
const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("embedding availability probes", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  async function createProbe(providerId = "openai", inlineQueryTimeoutMs?: number) {
    const entered = createDeferred<Parameters<EmbeddingProvider["embed"]>[1]>();
    const completion = createDeferred<number[]>();
    const embed = vi.fn<EmbeddingProvider["embed"]>(async (_input, options) => {
      entered.resolve(options);
      return await completion.promise;
    });
    const close = vi.fn(async () => {});
    const create = vi.spyOn(embeddings, "createEmbeddingProvider").mockResolvedValueOnce({
      requestedProvider: providerId,
      provider: {
        id: providerId,
        model: "mock-embed",
        embed,
        embedBatch: (inputs, options) => Promise.all(inputs.map((input) => embed(input, options))),
        close,
      },
      runtime: { id: providerId, inlineQueryTimeoutMs },
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: providerId }),
      "status",
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const probe = manager.probeEmbeddingAvailability();
    const options = await entered.promise;
    create.mockRestore();
    return { manager, probe, options, completion, embed, close };
  }

  it.each([
    { providerId: "openai", timeoutMs: 60_000, inlineQueryTimeoutMs: undefined },
    { providerId: "local", timeoutMs: 300_000, inlineQueryTimeoutMs: undefined },
    { providerId: "openai", timeoutMs: 90_000, inlineQueryTimeoutMs: 90_000 },
  ])(
    "bounds $providerId diagnostics with the $timeoutMs ms query budget without retrying",
    async ({ providerId, timeoutMs, inlineQueryTimeoutMs }) => {
      const { manager, probe, options, completion, embed } = await createProbe(
        providerId,
        inlineQueryTimeoutMs,
      );
      try {
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
        expect(embed).toHaveBeenCalledTimes(1);
      } finally {
        completion.resolve([1, 0]);
        await probe;
      }
    },
  );

  it("preserves managed readiness and allows a slow healthy query within its budget", async () => {
    const { probe, options, completion, embed } = await createProbe();
    try {
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
      expect(embed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      completion.resolve([1, 0]);
      await probe;
    }
  });

  it("holds the provider lease until a timed-out request settles", async () => {
    const { manager, probe, options, completion, close } = await createProbe("local");
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(options?.signal?.aborted).toBe(true);
      await expect(probe).resolves.toMatchObject({ ok: false });
      const closing = manager.close();
      expect(close).not.toHaveBeenCalled();
      completion.resolve([1, 0]);
      await closing;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      completion.resolve([1, 0]);
      await probe;
    }
  });
});
