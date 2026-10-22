import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const embeddings = await import("./embeddings.js");
const fixture = createManagerIndexFixture(await import("./index.js"));

it.each([
  ["openai", 60_000, undefined, false],
  ["local", 300_000, undefined, false],
  ["openai", 90_000, 90_000, false],
  ["openai", 60_000, undefined, true],
] as const)("probe %s: %i ms, override=%s, pause=%s", async (id, timeoutMs, override, pause) => {
  const model = id === "local" ? "embeddinggemma" : "mock-embed";
  const entered = createDeferred<Parameters<EmbeddingProvider["embed"]>[1]>();
  const completion = createDeferred<number[]>();
  const embed = vi.fn<EmbeddingProvider["embed"]>(async (_input, options) => {
    entered.resolve(options);
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
  const probe = manager.probeEmbeddingAvailability();
  const options = await entered.promise;
  create.mockRestore();
  try {
    if (pause) {
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
    await probe;
  }
});
