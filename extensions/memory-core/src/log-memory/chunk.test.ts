import { describe, expect, it } from "vitest";
import { approxTokenCount, slidingWindowChunks } from "./chunk.js";

describe("slidingWindowChunks", () => {
  it("returns single chunk for short text", () => {
    expect(slidingWindowChunks("hello world")).toEqual(["hello world"]);
  });

  it("splits long text with overlap", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `t${i}`).join(" ");
    const chunks = slidingWindowChunks(text, { maxTokens: 400, overlapTokens: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(approxTokenCount(chunk)).toBeLessThanOrEqual(400);
    }
    // Overlap must contain trailing tokens from the previous chunk.
    const firstTail = chunks[0].split(/\s+/).slice(-80);
    const secondHead = chunks[1].split(/\s+/).slice(0, 80);
    expect(secondHead).toEqual(firstTail);
  });

  it("guards against overlap >= maxTokens", () => {
    const text = Array.from({ length: 100 }, (_, i) => `t${i}`).join(" ");
    const chunks = slidingWindowChunks(text, { maxTokens: 10, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});
