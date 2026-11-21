import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./internal.js";
import { resolveMarkdownChunkMaxChars } from "./markdown-chunks.js";

describe("weighted memory chunk budgets", () => {
  it.each([
    { label: "long ASCII", text: "a".repeat(3000), tokens: 400, budget: 1600 },
    { label: "rare BMP ideographs", text: "\u3400".repeat(200), tokens: 400, budget: 1600 },
    { label: "supplementary ideographs", text: "\u{20000}".repeat(150), tokens: 400, budget: 1600 },
    { label: "odd UTF-16 split positions", text: "\u{20000}".repeat(120), tokens: 31, budget: 124 },
  ])("bounds $label without losing text or source positions", ({ text, tokens, budget }) => {
    const chunks = chunkMarkdown(text, { tokens, overlap: 0 });

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(estimateStringChars(chunk.text)).toBeLessThanOrEqual(budget);
      expect(() => encodeURIComponent(chunk.text)).not.toThrow();
      expect(chunk.startLine).toBe(1);
      expect(chunk.endLine).toBe(1);
    }
  });
});

describe("memory chunk ceiling", () => {
  it("derives the ceiling from the token budget", () => {
    expect(resolveMarkdownChunkMaxChars({ tokens: 400 })).toBe(1600);
    expect(resolveMarkdownChunkMaxChars({ tokens: 1 })).toBe(32);
  });

  it("never writes a chunk longer than the ceiling", () => {
    const chunking = { tokens: 400, overlap: 80 };
    const ceiling = resolveMarkdownChunkMaxChars(chunking);
    const lines = Array.from(
      { length: 400 },
      (_, index) => `Line ${index}: ${"word ".repeat(index % 40)}`,
    );
    const inputs = [
      lines.join("\n"),
      `${"a".repeat(5000)}\n${"b".repeat(1550)}\n${"c".repeat(1550)}`,
      "㐀".repeat(5000),
      `${"x".repeat(1599)}\n${"y".repeat(1599)}\n${"z".repeat(10)}`,
    ];
    for (const text of inputs) {
      const chunks = chunkMarkdown(text, chunking);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});
