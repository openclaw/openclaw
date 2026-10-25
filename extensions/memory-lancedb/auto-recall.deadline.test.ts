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
import memoryPlugin from "./index.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginRuntimeStateForTest();
});

test.each([10_000, 16_000])(
  "includes %ims of cold provider initialization in the auto-recall deadline",
  async (initializationMs) => {
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
          signal.addEventListener("abort", () => reject(new Error("Synthetic embedding aborted")), {
            once: true,
          });
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
    const pluginConfig = {
      embedding: { provider: provider.id, model: provider.model, dimensions: 3 },
      dbPath: "/unused/synthetic-memory-deadline",
      autoRecall: true,
      autoCapture: false,
    };
    const config = { plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } };
    const runtime = createPluginRuntimeMock();
    runtime.config.current = () => config;
    runtime.agent.resolveAgentDir = () => "/unused/synthetic-agent";
    const on = vi.fn();
    const registerService = vi.fn();
    memoryPlugin.register(
      createTestPluginApi({ pluginConfig, config, runtime, on, registerService }),
    );
    const hook = on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
    expect(hook).toBeTypeOf("function");
    const service = registerService.mock.calls[0]?.[0];
    service.start();
    vi.useFakeTimers();
    try {
      const recall = hook(
        { prompt: "Which synthetic editor do I prefer?", messages: [] },
        {
          agentId: "main",
          sessionKey: "agent:main:dashboard:synthetic-deadline",
          toolAuthority: {
            fingerprint: "synthetic-authority",
            allows: (name: string) => name === "memory_recall",
            assertActive() {},
          },
        },
      );
      await creating.promise;
      await vi.advanceTimersByTimeAsync(initializationMs);
      ready.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (initializationMs < 15_000) {
        expect(requests).toHaveLength(1);
        expect(requests[0]?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(15_000 - initializationMs);
        await expect(recall).resolves.toBeUndefined();
        expect(requests[0]?.aborted).toBe(true);
      } else {
        await expect(recall).resolves.toBeUndefined();
        expect(requests).toHaveLength(0);
      }
    } finally {
      ready.resolve();
      await vi.runAllTimersAsync();
      await service.stop();
    }
    expect(close).toHaveBeenCalledOnce();
  },
);
