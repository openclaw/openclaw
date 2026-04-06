import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

const mocks = vi.hoisted(() => ({
  listRegisteredMemoryEmbeddingProviderAdapters: vi.fn<() => MemoryEmbeddingProviderAdapter[]>(
    () => [],
  ),
}));

vi.mock("./provider-adapters.registry.runtime.js", () => ({
  listRegisteredMemoryEmbeddingProviderAdapters:
    mocks.listRegisteredMemoryEmbeddingProviderAdapters,
}));

beforeEach(() => {
  mocks.listRegisteredMemoryEmbeddingProviderAdapters.mockReset();
  mocks.listRegisteredMemoryEmbeddingProviderAdapters.mockReturnValue([]);
});

describe("registerBuiltInMemoryEmbeddingProviders", () => {
  it("uses only already-registered providers when avoiding duplicates", () => {
    const ids: string[] = [];

    registerBuiltInMemoryEmbeddingProviders({
      registerMemoryEmbeddingProvider(adapter) {
        ids.push(adapter.id);
      },
    });

    expect(ids).toEqual(["local", "openai", "gemini", "voyage", "mistral"]);
    expect(mocks.listRegisteredMemoryEmbeddingProviderAdapters).toHaveBeenCalledTimes(1);
  });

  it("skips builtin adapters that are already registered in the current load", () => {
    mocks.listRegisteredMemoryEmbeddingProviderAdapters.mockReturnValue([
      { id: "local", create: vi.fn() } as MemoryEmbeddingProviderAdapter,
      { id: "gemini", create: vi.fn() } as MemoryEmbeddingProviderAdapter,
    ]);
    const ids: string[] = [];

    registerBuiltInMemoryEmbeddingProviders({
      registerMemoryEmbeddingProvider(adapter) {
        ids.push(adapter.id);
      },
    });

    expect(ids).toEqual(["openai", "voyage", "mistral"]);
  });
});
