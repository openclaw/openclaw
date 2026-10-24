import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  restoreRegisteredEmbeddingProviders,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { createEmbeddingProvider, resolveEmbeddingProviderIndexIdentity } from "./embeddings.js";

it("preserves a contract-declared provider and its identity metadata", async ({
  onTestFinished,
}) => {
  const previousPluginRegistry = getActivePluginRegistry();
  const embeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  onTestFinished(() => {
    clearEmbeddingProviders();
    setActivePluginRegistry(previousPluginRegistry ?? createEmptyPluginRegistry());
    restoreRegisteredEmbeddingProviders(embeddingProvidersSnapshot);
  });
  clearEmbeddingProviders();
  const cacheKey = (model: string, dimensions: number | undefined) => ({
    provider: "virtual-generic",
    model,
    dimensions,
  });
  const aliases = (dimensions: number | undefined) => [
    {
      model: "virtual-model-legacy",
      cacheKeyData: cacheKey("virtual-model-legacy", dimensions),
    },
  ];
  const identity = { cacheKeyData: cacheKey("virtual-model", 7), aliases: aliases(7) };
  const runtime = {
    id: "virtual-generic",
    inlineQueryTimeoutMs: 1234,
    inlineBatchTimeoutMs: 5678,
    cacheKeyData: identity.cacheKeyData,
    indexIdentityAliases: identity.aliases,
  };
  const embed = vi.fn(async () => [1, 2, 3]);
  const embedBatch = vi.fn(async (inputs: EmbeddingInput[]) =>
    inputs.map((_input, index) => [index, 7]),
  );
  const { config, registry } = createPluginRegistryFixture({ plugins: { enabled: false } });
  const providerOptions = {
    config,
    agentDir: "/tmp/openclaw-agent",
    provider: "virtual-generic",
    fallback: "none",
    model: "virtual-model",
    outputDimensionality: 7,
  };

  registerVirtualTestPlugin({
    registry,
    config,
    id: "virtual-generic-plugin",
    name: "Virtual Generic Embeddings",
    contracts: {
      embeddingProviders: ["virtual-generic"],
    },
    register(api) {
      api.registerEmbeddingProvider({
        id: "virtual-generic",
        transport: "remote",
        defaultModel: "virtual-default",
        resolveIndexIdentity: (options) => ({
          model: options.model,
          cacheKeyData: cacheKey(options.model, options.dimensions),
          aliases: aliases(options.dimensions),
        }),
        create: async (options) => {
          expect(options.model).toBe("virtual-model");
          expect(options.dimensions).toBe(7);
          expect(options.config).toBe(config);
          return {
            provider: {
              id: "virtual-generic",
              model: options.model,
              dimensions: options.dimensions,
              maxInputTokens: 2048,
              embed,
              embedBatch,
            },
            runtime: {
              ...runtime,
              cacheKeyData: cacheKey(options.model, options.dimensions),
              indexIdentityAliases: aliases(options.dimensions),
            },
          };
        },
      });
    },
  });
  setActivePluginRegistry(registry.registry);

  expect(getRegisteredEmbeddingProvider("virtual-generic")?.ownerPluginId).toBe(
    "virtual-generic-plugin",
  );
  expect(registry.registry.embeddingProviders.map((entry) => entry.provider.id)).toEqual([
    "virtual-generic",
  ]);
  expect(resolveEmbeddingProviderIndexIdentity(providerOptions)).toEqual({
    provider: { id: "virtual-generic", model: "virtual-model" },
    ...identity,
  });

  const result = await createEmbeddingProvider(providerOptions);

  expect(result.requestedProvider).toBe("virtual-generic");
  expect(result.provider).toMatchObject({
    id: "virtual-generic",
    model: "virtual-model",
    dimensions: 7,
    maxInputTokens: 2048,
  });
  expect(result.runtime).toEqual(runtime);

  await expect(result.provider?.embed("query", { inputType: "query" })).resolves.toEqual([1, 2, 3]);
  expect(embed).toHaveBeenCalledExactlyOnceWith("query", { inputType: "query" });
  const inputs: EmbeddingInput[] = [
    "doc-a",
    { text: "doc-b", parts: [{ type: "text", text: "doc-b" }] },
  ];
  await expect(result.provider?.embedBatch(inputs, { inputType: "document" })).resolves.toEqual([
    [0, 7],
    [1, 7],
  ]);
  expect(embedBatch).toHaveBeenCalledExactlyOnceWith(inputs, { inputType: "document" });
});
