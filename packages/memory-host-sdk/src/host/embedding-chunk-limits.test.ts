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

function expectChunksWithinUtf8Bytes(chunks: EmbeddingChunks, maxBytes: number) {
  for (const chunk of chunks) {
    expect(estimateUtf8Bytes(chunk.text)).toBeLessThanOrEqual(maxBytes);
  }
}

function expectChunksLineRange(chunks: EmbeddingChunks, startLine: number, endLine: number) {
  for (const chunk of chunks) {
    expect(chunk).toMatchObject({ startLine, endLine });
  }
}

function expectChunksHaveHashes(chunks: EmbeddingChunks) {
  for (const chunk of chunks) {
    expect(typeof chunk.hash).toBe("string");
    expect(chunk.hash.length).toBeGreaterThan(0);
  }
}

function joinedChunkText(chunks: EmbeddingChunks): string {
  return chunks.map((chunk) => chunk.text).join("");
}

function makeChunk(text: string) {
  return { startLine: 1, endLine: 1, text, hash: "ignored" };
}

describe("embedding chunk limits", () => {
  it("splits oversized chunks so each embedding input stays <= maxInputTokens bytes", () => {
    const provider = createProvider(8192);
    const input = {
      ...makeChunk("x".repeat(9000)),
      entryStartLine: 1,
      entryEndLine: 4,
    };

    const out = enforceEmbeddingMaxInputTokens(provider, [input]);
    expect(out.length).toBeGreaterThan(1);
    expect(joinedChunkText(out)).toBe(input.text);
    expectChunksWithinUtf8Bytes(out, 8192);
    expectChunksLineRange(out, 1, 1);
    expectChunksHaveHashes(out);
    expect(out.every((chunk) => chunk.entryStartLine === 1 && chunk.entryEndLine === 4)).toBe(true);
  });

  it("does not split inside surrogate pairs (emoji)", () => {
    const provider = createProvider(8192);
    const emoji = "😀";
    const inputText = `${emoji.repeat(2100)}\n${emoji.repeat(2100)}`;

    const out = enforceEmbeddingMaxInputTokens(provider, [{ ...makeChunk(inputText), endLine: 2 }]);

    expect(out.length).toBeGreaterThan(1);
    expect(joinedChunkText(out)).toBe(inputText);
    expectChunksWithinUtf8Bytes(out, 8192);

    // If we split inside surrogate pairs we'd likely end up with replacement chars.
    expect(joinedChunkText(out)).not.toContain("\uFFFD");
  });

  it.each([
    { cap: 1, expected: ["😀", "t", "a", "i", "l", "😀"] },
    { cap: 2, expected: ["😀", "ta", "il", "😀"] },
    { cap: 3, expected: ["😀", "tai", "l", "😀"] },
  ])("retains indivisible code points when the byte cap is $cap", ({ cap, expected }) => {
    const out = enforceEmbeddingMaxInputTokens(createProvider(8192), [makeChunk("😀tail😀")], cap);

    expect(out.map((chunk) => chunk.text)).toEqual(expected);
  });

  it("uses conservative fallback limits for local providers without declared maxInputTokens", () => {
    const provider = createProvider(undefined, "local");

    const out = enforceEmbeddingMaxInputTokens(provider, [makeChunk("x".repeat(3000))]);

    expect(out.length).toBeGreaterThan(1);
    expectChunksWithinUtf8Bytes(out, 2048);
  });

  it("honors hard safety caps lower than provider maxInputTokens", () => {
    const provider = createProvider(8192);
    const out = enforceEmbeddingMaxInputTokens(provider, [makeChunk("x".repeat(8100))], 8000);

    expect(out.length).toBeGreaterThan(1);
    expectChunksWithinUtf8Bytes(out, 8000);
  });
});
