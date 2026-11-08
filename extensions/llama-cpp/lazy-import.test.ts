import { expectDefined } from "@openclaw/normalization-core";
import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const executionModules = [
  "./src/setup.js",
  "./src/external-server/setup.js",
  "./src/external-server/provider.js",
  "./src/external-server/stream.js",
  "./src/managed-server.js",
  "./src/embedding-provider.runtime.js",
  "./src/media-provider.runtime.js",
] as const;

describe("llama.cpp registration", () => {
  afterEach(() => {
    for (const module of executionModules) {
      vi.doUnmock(module);
    }
    vi.resetModules();
  });

  it("exposes capabilities and identities without loading execution runtimes", async () => {
    for (const module of executionModules) {
      // mock-isolation: fail runtime imports so registration cannot hide eager execution loading.
      vi.doMock(module, () => {
        throw new Error(`execution runtime loaded: ${module}`);
      });
    }
    const { default: plugin } = await import("./index.js");
    const providers: ProviderPlugin[] = [];
    const embeddings: EmbeddingProviderAdapter[] = [];
    const media: MediaUnderstandingProvider[] = [];
    plugin.register(
      createTestPluginApi({
        registerProvider: (provider) => providers.push(provider),
        registerEmbeddingProvider: (provider) => embeddings.push(provider),
        registerMediaUnderstandingProvider: (provider) => media.push(provider),
      }),
    );
    const provider = expectDefined(providers[0], "text provider");
    const embedding = expectDefined(embeddings[0], "embedding provider");
    const image = expectDefined(media[0], "image provider");
    expect(provider.auth.map(({ id }) => id)).toEqual(["local", "existing-server", "local-media"]);
    expect(embedding).toMatchObject({ id: "local", transport: "local" });
    expect(image).toMatchObject({ id: "llama-cpp", capabilities: ["image"] });
    expect(
      embedding.resolveIndexIdentity?.({
        config: {},
        provider: "local",
        model: "/models/custom.gguf",
        local: { modelPath: "/models/custom.gguf" },
      }),
    ).toMatchObject({ model: "/models/custom.gguf", aliases: [] });

    const wrapped = expectDefined(
      provider.wrapStreamFn?.({ provider: "llama-cpp", modelId: "synthetic-model" }),
      "lazy stream wrapper",
    );
    const expectRuntimeImport = async (operation: Promise<unknown>, module: string) => {
      await expect(operation).rejects.toMatchObject({
        cause: { message: `execution runtime loaded: ${module}` },
      });
    };
    await expectRuntimeImport(
      Promise.resolve(wrapped({} as never, { messages: [] }, {})),
      "./src/external-server/stream.js",
    );
    await expectRuntimeImport(provider.auth[0]!.run({} as never), "./src/setup.js");
    await expectRuntimeImport(provider.auth[1]!.run({} as never), "./src/external-server/setup.js");
    await expectRuntimeImport(
      Promise.resolve(
        provider.prepareDynamicModel!({
          provider: "llama-cpp",
          modelId: "synthetic-model",
        } as never),
      ),
      "./src/external-server/provider.js",
    );
    await expectRuntimeImport(
      provider.reconcileLocalService!({ baseUrl: "http://127.0.0.1:19432/v1" }),
      "./src/managed-server.js",
    );
    await expectRuntimeImport(
      embedding.create({ config: {}, provider: "local", model: "synthetic-model" }),
      "./src/embedding-provider.runtime.js",
    );
    await expectRuntimeImport(image.describeImage!({} as never), "./src/media-provider.runtime.js");
  });
});
