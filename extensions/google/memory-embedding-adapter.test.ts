import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGeminiEmbeddingProvider: vi.fn(),
}));

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return { ...actual, createGeminiEmbeddingProvider: mocks.createGeminiEmbeddingProvider };
});

import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const MODEL = "gemini-embedding-2";
const VERSION = "openclaw/2026.7.1-beta.5";
const provider: MemoryEmbeddingProvider = {
  id: "gemini",
  model: MODEL,
  embed: async () => [1, 0],
  embedBatch: async (inputs) => inputs.map(() => [1, 0]),
};

async function createAdapter(headers: Record<string, string>, version?: string) {
  mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
    provider,
    client: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: MODEL,
      modelPath: "models/gemini-embedding-2",
      outputDimensionality: 768,
      headers: { ...headers, ...(version ? { "x-goog-api-client": version } : {}) },
    },
  });
  return await geminiMemoryEmbeddingProviderAdapter.create({
    config: {} as never,
    provider: "gemini",
    model: MODEL,
    fallback: "none",
  });
}

describe("Gemini memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createGeminiEmbeddingProvider.mockReset();
  });

  it.each([
    ["gemini-embedding-2", true],
    ["gemini-embedding-2-preview", true],
    ["gemini-embedding-001", false],
  ] as const)("resolves multimodal support for %s", (model, expected) => {
    expect(geminiMemoryEmbeddingProviderAdapter.supportsMultimodalEmbeddings?.({ model })).toBe(
      expected,
    );
  });

  it.each(["client-version", "semantic-header"])("keys memory identity by %s", async (change) => {
    const stable = change === "client-version";
    const sharedHeaders = {
      "Content-Type": "application/json",
      "x-goog-api-key": "secret-key",
      Authorization: "Bearer token",
      "X-Custom-Region": "us-central1",
    };
    const firstHeaders = stable ? sharedHeaders : { ...sharedHeaders, "X-Scope": "a" };
    const secondHeaders = stable ? sharedHeaders : { ...sharedHeaders, "X-Scope": "b" };
    const first = await createAdapter(firstHeaders, stable ? "openclaw/2026.6.11" : VERSION);
    const second = await createAdapter(secondHeaders, VERSION);
    if (stable) {
      expect(first.runtime?.cacheKeyData).toEqual(second.runtime?.cacheKeyData);
      expect(first.runtime?.cacheKeyData?.headers).toEqual([
        ["Content-Type", "application/json"],
        ["X-Custom-Region", "us-central1"],
      ]);
    } else {
      expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
    }
  });
});
