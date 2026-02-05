/**
 * Tests for embeddings.ts — Embedding Provider.
 *
 * Tests the Embeddings class with mocked OpenAI client and mocked fetch for Ollama.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

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

// ============================================================================
// Ollama context-length truncation
// ============================================================================

describe("Embeddings - Ollama context-length truncation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ embeddings: [[0.1, 0.2, 0.3]] }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should truncate long input before calling Ollama embed", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    // mxbai-embed-large context length is 512, so maxChars = 512 * 3 = 1536
    // Create input that exceeds the limit
    const longText = "word ".repeat(500); // ~2500 chars, well above 1536
    await emb.embed(longText);

    // Verify the text sent to Ollama was truncated
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.input.length).toBeLessThanOrEqual(512 * 3);
  });

  it("should truncate at word boundary (not mid-word)", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    // maxChars for mxbai-embed-large = 512 * 3 = 1536
    // Each "abcdefghij " is 11 chars; 200 repeats = 2200 chars total (exceeds 1536)
    const longText = "abcdefghij ".repeat(200);
    await emb.embed(longText);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    const sentText = body.input as string;

    expect(sentText.length).toBeLessThanOrEqual(512 * 3);
    // The truncation should land on a word boundary: the sent text should
    // be a prefix of the original that ends at a complete word (i.e. the
    // character after the sent text in the original should be a space).
    // Since the pattern is "abcdefghij " repeated, a word-boundary cut
    // means sentText ends with "abcdefghij" (no trailing partial word).
    expect(sentText).toMatch(/abcdefghij$/);
    // Verify it's a proper prefix of the original
    expect(longText.startsWith(sentText)).toBe(true);
  });

  it("should pass short input through unchanged", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    const shortText = "This is a short text that fits within context length.";
    await emb.embed(shortText);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.input).toBe(shortText);
  });

  it("should use model-specific context length for truncation", async () => {
    const { Embeddings } = await import("./embeddings.js");
    // nomic-embed-text has context length 8192, maxChars = 8192 * 3 = 24576
    const emb = new Embeddings(undefined, "nomic-embed-text", "ollama");

    // Create text that exceeds mxbai limit (1536) but fits nomic limit (24576)
    const mediumText = "hello ".repeat(400); // ~2400 chars
    await emb.embed(mediumText);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    // Should NOT be truncated since 2400 < 24576
    expect(body.input).toBe(mediumText);
  });

  it("should truncate each item individually in embedBatch", async () => {
    const { Embeddings } = await import("./embeddings.js");
    const emb = new Embeddings(undefined, "mxbai-embed-large", "ollama");

    // maxChars for mxbai-embed-large = 512 * 3 = 1536
    const longText = "word ".repeat(500); // ~2500 chars, exceeds limit
    const shortText = "short text"; // well under limit

    await emb.embedBatch([longText, shortText]);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    // First call: long text should be truncated
    const body1 = JSON.parse(calls[0][1].body as string);
    expect(body1.input.length).toBeLessThanOrEqual(512 * 3);
    expect(body1.input.length).toBeLessThan(longText.length);

    // Second call: short text should pass through unchanged
    const body2 = JSON.parse(calls[1][1].body as string);
    expect(body2.input).toBe(shortText);
  });
});
