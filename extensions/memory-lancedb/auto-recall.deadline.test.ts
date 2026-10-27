import {
  createEmptyPluginRegistry,
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, test, vi } from "vitest";
import { createEmbeddings } from "./embeddings.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginRuntimeStateForTest();
});

test.each([10_000, 16_000])("bounds cold provider startup (%ims)", async (initializationMs) => {
  const ready = createDeferred<void>();
  const creating = createDeferred<void>();
  const requests: AbortSignal[] = [];
  const close = vi.fn();
  const provider: EmbeddingProvider = {
    id: "synthetic-cold-local",
    model: "synthetic-embedding",
    embed: async (_input, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected a bounded recall request");
      }
      requests.push(signal);
      return await new Promise<number[]>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("memory-lancedb embedding timed out")),
          {
            once: true,
          },
        );
      });
    },
    embedBatch: async () => [],
    close,
  };
  const registry = createEmptyPluginRegistry();
  registry.embeddingProviders.push({
    pluginId: "synthetic-provider",
    source: "test",
    provider: {
      id: provider.id,
      transport: "local",
      create: async () => {
        creating.resolve();
        await ready.promise;
        return { provider };
      },
    },
  });
  setActivePluginRegistry(registry);
  const runtime = createPluginRuntimeMock();
  runtime.agent.resolveAgentDir = () => "/unused/synthetic-agent";
  const embeddings = createEmbeddings(createTestPluginApi({ runtime }));
  const config = { provider: provider.id, model: provider.model };
  vi.useFakeTimers();
  try {
    const pending = embeddings.embed("main", "Which editor?", config, 15_000);
    const rejected = expect(pending).rejects.toThrow("memory-lancedb embedding timed out");
    await creating.promise;
    await vi.advanceTimersByTimeAsync(initializationMs);
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (initializationMs < 15_000) {
      expect(requests[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000 - initializationMs);
    }
    await rejected;
    expect(requests.map((signal) => signal.aborted)).toEqual(
      initializationMs < 15_000 ? [true] : [],
    );
  } finally {
    ready.resolve();
    await vi.runAllTimersAsync();
    await embeddings.close?.();
  }
  expect(close).toHaveBeenCalledOnce();
});

test("keeps the cold-start embed deadline on the monotonic clock across a wall-clock step", async () => {
  // A host clock correction during shared provider cold-start must not shrink the
  // remaining abort budget (which would reject a healthy query as timed out).
  const ready = createDeferred<void>();
  const creating = createDeferred<void>();
  const requests: AbortSignal[] = [];
  const close = vi.fn();
  const provider: EmbeddingProvider = {
    id: "synthetic-clock-step-local",
    model: "synthetic-embedding",
    embed: async (_input, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected a bounded recall request");
      }
      requests.push(signal);
      return await new Promise<number[]>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("memory-lancedb embedding timed out")),
          { once: true },
        );
      });
    },
    embedBatch: async () => [],
    close,
  };
  const registry = createEmptyPluginRegistry();
  registry.embeddingProviders.push({
    pluginId: "synthetic-provider",
    source: "test",
    provider: {
      id: provider.id,
      transport: "local",
      create: async () => {
        creating.resolve();
        await ready.promise;
        return { provider };
      },
    },
  });
  setActivePluginRegistry(registry);
  const runtime = createPluginRuntimeMock();
  runtime.agent.resolveAgentDir = () => "/unused/synthetic-agent";
  const embeddings = createEmbeddings(createTestPluginApi({ runtime }));
  const config = { provider: provider.id, model: provider.model };
  vi.useFakeTimers();
  try {
    const pending = embeddings.embed("main", "Which editor?", config, 15_000);
    const rejected = expect(pending).rejects.toThrow("memory-lancedb embedding timed out");
    await creating.promise;
    // A +30s wall-clock step lands between the deadline seed and the remaining-budget
    // read (the host NTP correction that lands mid cold-start). Date.now() jumps,
    // performance.now() does not.
    vi.setSystemTime(Date.now() + 30_000);
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The healthy query was never abandoned by the clock step: it still gets a bounded
    // request that is not yet aborted.
    expect(requests[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(requests.map((signal) => signal.aborted)).toEqual([true]);
  } finally {
    ready.resolve();
    await vi.runAllTimersAsync();
    await embeddings.close?.();
  }
  expect(close).toHaveBeenCalledOnce();
});
