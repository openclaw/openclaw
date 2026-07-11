import { createHash } from "node:crypto";
// Google tests cover memory embedding adapter plugin behavior.
import {
  sanitizeEmbeddingCacheHeaders,
  type MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGeminiEmbeddingProvider: vi.fn(),
  runGeminiEmbeddingBatches: vi.fn(async () => new Map([["0", [1, 0]]])),
}));

vi.mock("./embedding-provider.js", () => ({
  DEFAULT_GEMINI_EMBEDDING_MODEL: "gemini-embedding-001",
  createGeminiEmbeddingProvider: mocks.createGeminiEmbeddingProvider,
  buildGeminiEmbeddingRequest: vi.fn(),
}));

vi.mock("./embedding-batch.js", () => ({
  runGeminiEmbeddingBatches: mocks.runGeminiEmbeddingBatches,
}));

import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const provider: MemoryEmbeddingProvider = {
  id: "gemini",
  model: "gemini-embedding-2-preview",
  embedQuery: async () => [1, 0],
  embedBatch: async (texts) => texts.map(() => [1, 0]),
};

function hashProviderKey(cacheKeyData: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(cacheKeyData)).digest("hex");
}

describe("Gemini memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createGeminiEmbeddingProvider.mockReset();
    mocks.runGeminiEmbeddingBatches.mockClear();
  });

  it("excludes generated x-goog-api-client from durable memory identity headers", async () => {
    mocks.createGeminiEmbeddingProvider.mockResolvedValue({
      provider,
      client: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": "secret-key",
          "x-goog-api-client": "openclaw/2026.7.1-beta.5",
          Authorization: "Bearer token",
          "X-Custom-Region": "us-central1",
        },
        model: "gemini-embedding-2-preview",
        modelPath: "models/gemini-embedding-2-preview",
        outputDimensionality: 768,
      },
    });

    const result = await geminiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    const headers = result.runtime?.cacheKeyData?.headers;
    expect(headers).toEqual(
      sanitizeEmbeddingCacheHeaders(
        {
          "Content-Type": "application/json",
          "X-Custom-Region": "us-central1",
        },
        [],
      ),
    );
    expect(headers).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["x-goog-api-client"]),
        expect.arrayContaining(["x-goog-api-key"]),
        expect.arrayContaining(["Authorization"]),
      ]),
    );
  });

  it("keeps provider identity stable across OpenClaw client-version attribution changes", async () => {
    const sharedClient = {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-embedding-2-preview",
      modelPath: "models/gemini-embedding-2-preview",
      outputDimensionality: 768,
    };

    mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
      provider,
      client: {
        ...sharedClient,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-client": "openclaw/2026.6.11",
          "x-custom-endpoint": "https://example.invalid/embed",
        },
      },
    });
    mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
      provider,
      client: {
        ...sharedClient,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-client": "openclaw/2026.7.1-beta.5",
          "x-custom-endpoint": "https://example.invalid/embed",
        },
      },
    });

    const older = await geminiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });
    const newer = await geminiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    const olderKey = hashProviderKey(older.runtime?.cacheKeyData as Record<string, unknown>);
    const newerKey = hashProviderKey(newer.runtime?.cacheKeyData as Record<string, unknown>);
    expect(olderKey).toBe(newerKey);
    expect(older.runtime?.cacheKeyData).toEqual(newer.runtime?.cacheKeyData);
  });

  it("still invalidates identity when a semantic custom header changes", async () => {
    const sharedClient = {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-embedding-2-preview",
      modelPath: "models/gemini-embedding-2-preview",
      outputDimensionality: 768,
    };

    mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
      provider,
      client: {
        ...sharedClient,
        headers: {
          "x-goog-api-client": "openclaw/2026.7.1-beta.5",
          "x-custom-endpoint": "https://example.invalid/a",
        },
      },
    });
    mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
      provider,
      client: {
        ...sharedClient,
        headers: {
          "x-goog-api-client": "openclaw/2026.7.1-beta.5",
          "x-custom-endpoint": "https://example.invalid/b",
        },
      },
    });

    const first = await geminiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });
    const second = await geminiMemoryEmbeddingProviderAdapter.create({
      config: {} as never,
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
    });

    expect(hashProviderKey(first.runtime?.cacheKeyData as Record<string, unknown>)).not.toBe(
      hashProviderKey(second.runtime?.cacheKeyData as Record<string, unknown>),
    );
  });
});
