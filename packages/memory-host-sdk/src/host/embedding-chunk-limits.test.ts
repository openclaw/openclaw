import { describe, expect, it } from "vitest";
import { enforceEmbeddingMaxInputTokens } from "./embedding-chunk-limits.js";
import { estimateUtf8Bytes } from "./embedding-input-limits.js";
import type { EmbeddingProvider } from "./embeddings.types.js";

function createProvider(maxInputTokens?: number, id = "mock"): EmbeddingProvider {
  return {
    id,
    model: "mock-embed",
    maxInputTokens,
    embed: async () => [0],
    embedBatch: async () => [[0]],
  };
}

type EmbeddingChunks = ReturnType<typeof enforceEmbeddingMaxInputTokens>;

function expectSplit(chunks: EmbeddingChunks, text: string, maxBytes: number) {
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  for (const chunk of chunks) {
    expect(estimateUtf8Bytes(chunk.text)).toBeLessThanOrEqual(maxBytes);
  }
}

function makeChunk(text: string) {
  return { startLine: 1, endLine: 1, text, hash: "ignored" };
}

describe("embedding chunk limits", () => {
  it("splits oversized chunks so each embedding input stays <= maxInputTokens bytes", () => {
    const input = {
      ...makeChunk("x".repeat(9000)),
      entryStartLine: 1,
      entryEndLine: 4,
    };

    const out = enforceEmbeddingMaxInputTokens(createProvider(8192), [input]);
    expectSplit(out, input.text, 8192);
    for (const chunk of out) {
      expect(chunk).toMatchObject({
        startLine: 1,
        endLine: 1,
        entryStartLine: 1,
        entryEndLine: 4,
      });
      expect(typeof chunk.hash).toBe("string");
      expect(chunk.hash.length).toBeGreaterThan(0);
    }
  });

  it("does not split inside surrogate pairs (emoji)", () => {
    const text = `${"😀".repeat(2100)}\n${"😀".repeat(2100)}`;
    const out = enforceEmbeddingMaxInputTokens(createProvider(8192), [
      { ...makeChunk(text), endLine: 2 },
    ]);
    expectSplit(out, text, 8192);
    expect(out.map((chunk) => chunk.text).join("")).not.toContain("\uFFFD");
  });

  it.each([
    { cap: 1, expected: ["😀", "t", "a", "i", "l", "😀"] },
    { cap: 2, expected: ["😀", "ta", "il", "😀"] },
    { cap: 3, expected: ["😀", "tai", "l", "😀"] },
  ])("retains indivisible code points when the byte cap is $cap", ({ cap, expected }) => {
    const out = enforceEmbeddingMaxInputTokens(createProvider(8192), [makeChunk("😀tail😀")], cap);

    expect(out.map((chunk) => chunk.text)).toEqual(expected);
  });

  it.each([
    ["undeclared local limit", undefined, "local", 3000, undefined, 2048],
    ["hard safety cap", 8192, "mock", 8100, 8000, 8000],
  ] as const)("splits at the %s", (_name, limit, id, size, cap, expected) => {
    const text = "x".repeat(size);
    const out = enforceEmbeddingMaxInputTokens(createProvider(limit, id), [makeChunk(text)], cap);
    expectSplit(out, text, expected);
  });
});
