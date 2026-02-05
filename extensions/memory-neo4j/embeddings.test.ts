/**
 * Tests for embeddings.ts — Embedding Provider.
 *
 * Tests the Embeddings class with mocked OpenAI client and mocked fetch for Ollama.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ============================================================================
// Constructor
// ============================================================================

describe("Embeddings constructor", () => {
  it("should throw when OpenAI provider is used without API key", async () => {
    const { Embeddings } = await import("./embeddings.js");
    expect(() => new Embeddings(undefined, "text-embedding-3-small", "openai")).toThrow(
      "API key required for OpenAI embeddings",
    );
  });

  it("should not require API key for ollama provider", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    expect(emb).toBeDefined();
  });
});

// ============================================================================
// Ollama embed
// ============================================================================

describe("Embeddings - Ollama provider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should call Ollama API with correct request body", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVector] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    const result = await emb.embed("test text");

    expect(result).toEqual(mockVector);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mxbai-embed-large",
          input: "test text",
        }),
      }),
    );
  });

  it("should use custom baseUrl for Ollama", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const mockVector = [0.5, 0.6];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [mockVector] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama", "http://my-host:11434");
    await emb.embed("test");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://my-host:11434/api/embed",
      expect.any(Object),
    );
  });

  it("should throw when Ollama returns error status", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("Ollama embedding failed: 500");
  });

  it("should throw when Ollama returns no embeddings", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [] }),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("No embedding returned from Ollama");
  });

  it("should throw when Ollama returns null embeddings", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("No embedding returned from Ollama");
  });

  it("should propagate fetch errors for Ollama", async () => {
    const { Embeddings } = await import("./embeddings.js");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    await expect(emb.embed("test")).rejects.toThrow("Network error");
  });
});

// ============================================================================
// OpenAI embed (via mocked client internals)
// ============================================================================

describe("Embeddings - OpenAI provider", () => {
  it("should create instance with OpenAI provider when API key provided", async () => {
    const { Embeddings } = await import("./embeddings.js");
    // Just verify construction succeeds with valid params
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");
    expect(emb).toBeDefined();
  });

  it("should have embed and embedBatch methods", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test-key", "text-embedding-3-small", "openai");
    expect(typeof emb.embed).toBe("function");
    expect(typeof emb.embedBatch).toBe("function");
  });
});

// ============================================================================
// Batch embedding
// ============================================================================

describe("Embeddings - embedBatch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should return empty array for empty input (openai)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings("sk-test", "text-embedding-3-small", "openai");
    const results = await emb.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("should return empty array for empty input (ollama)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    const results = await emb.embedBatch([]);
    expect(results).toEqual([]);
  });

  it("should use sequential calls for Ollama batch (no native batch support)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ embeddings: [[callCount * 0.1, callCount * 0.2]] }),
      });
    });

    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");
    const results = await emb.embedBatch(["text1", "text2", "text3"]);

    // Should make 3 separate calls
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    // Each result should be a vector
    for (const r of results) {
      expect(Array.isArray(r)).toBe(true);
      expect(r.length).toBe(2);
    }
  });
});
