import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltInMemoryEmbeddingProviders } from "./provider-adapters.js";

const mocks = vi.hoisted(() => ({
  listRegisteredMemoryEmbeddingProviderAdapters: vi.fn<() => MemoryEmbeddingProviderAdapter[]>(
    () => [],
  ),
  listMemoryEmbeddingProviders: vi.fn(() => {
    throw new Error("fallback capability loading should stay cold during memory-core register");
  }),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")
  >("openclaw/plugin-sdk/memory-core-host-engine-embeddings");
  return {
    ...actual,
    listRegisteredMemoryEmbeddingProviderAdapters:
      mocks.listRegisteredMemoryEmbeddingProviderAdapters,
    listMemoryEmbeddingProviders: mocks.listMemoryEmbeddingProviders,
  };
});

beforeEach(() => {
  mocks.listRegisteredMemoryEmbeddingProviderAdapters.mockReset();
  mocks.listRegisteredMemoryEmbeddingProviderAdapters.mockReturnValue([]);
  mocks.listMemoryEmbeddingProviders.mockClear();
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
    expect(mocks.listMemoryEmbeddingProviders).not.toHaveBeenCalled();
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
    expect(mocks.listMemoryEmbeddingProviders).not.toHaveBeenCalled();
  });
});
