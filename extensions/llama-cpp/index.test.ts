import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  clearMemoryEmbeddingProviders,
  getRegisteredEmbeddingProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const memoryHostEmbeddingMocks = vi.hoisted(() => ({
  createLocalEmbeddingProvider: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  createLocalEmbeddingProvider: memoryHostEmbeddingMocks.createLocalEmbeddingProvider,
}));

import llamaCppPlugin from "./index.js";
import {
  DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
  createLlamaCppEmbeddingProvider,
  formatLlamaCppSetupError,
} from "./src/embedding-provider.js";

afterEach(() => {
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
  memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockReset();
});

describe("llama.cpp provider plugin", () => {
  it("registers the local embedding provider through the generic SDK contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "llama-cpp",
      name: "llama.cpp Provider",
      contracts: {
        embeddingProviders: ["local"],
      },
      register: llamaCppPlugin.register,
    });

    const provider = getRegisteredEmbeddingProvider("local");
    expect(provider?.ownerPluginId).toBe("llama-cpp");
    expect(provider?.adapter).toMatchObject({
      id: "local",
      defaultModel: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      transport: "local",
    });
  });

  it("adapts the worker-backed local embedding provider", async () => {
    const close = vi.fn();
    memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mockResolvedValue({
      id: "local",
      model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
      maxInputTokens: 2048,
      embedQuery: vi.fn(async () => [0.6, 0.8]),
      embedBatchInputs: vi.fn(async () => [[0.3, 0.4]]),
      embedBatch: vi.fn(async () => [[1, 0]]),
      close,
    });
    const abortController = new AbortController();

    const provider = await createLlamaCppEmbeddingProvider(
      {
        config: {},
        provider: "local",
        model: "text-embedding-3-small",
      },
      { nodeLlamaCppImportUrl: "file:///plugin/node-llama-cpp.js" },
    );

    await expect(provider.embed("hello")).resolves.toEqual([0.6, 0.8]);
    await expect(
      provider.embedBatch([{ text: "doc" }], { signal: abortController.signal }),
    ).resolves.toEqual([[0.3, 0.4]]);
    await provider.close?.();

    expect(provider.model).toBe(DEFAULT_LLAMA_CPP_EMBEDDING_MODEL);
    expect(provider.maxInputTokens).toBe(2048);
    expect(close).toHaveBeenCalledTimes(1);
    expect(memoryHostEmbeddingMocks.createLocalEmbeddingProvider).toHaveBeenCalledWith(
      {
        config: {},
        provider: "local",
        fallback: "none",
        model: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
        local: {
          modelPath: DEFAULT_LLAMA_CPP_EMBEDDING_MODEL,
        },
      },
      {
        nodeLlamaCppImportUrl: "file:///plugin/node-llama-cpp.js",
      },
    );
    const workerProvider =
      await memoryHostEmbeddingMocks.createLocalEmbeddingProvider.mock.results[0].value;
    expect(workerProvider.embedBatchInputs).toHaveBeenCalledWith([{ text: "doc" }], {
      signal: abortController.signal,
    });
  });

  it("formats missing runtime errors with the plugin install command", () => {
    const err = Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    expect(formatLlamaCppSetupError(err)).toContain(
      "openclaw plugins install @openclaw/llama-cpp-provider",
    );
  });
});
