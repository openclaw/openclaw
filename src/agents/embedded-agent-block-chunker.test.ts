// Covers streaming chunk boundaries for embedded-agent text blocks.
import { describe, expect, it, vi } from "vitest";
import * as fences from "../../packages/markdown-core/src/fences.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";

function createFlushOnParagraphChunker(params: { minChars: number; maxChars: number }) {
  return new EmbeddedBlockChunker({
    minChars: params.minChars,
    maxChars: params.maxChars,
    breakPreference: "paragraph",
    flushOnParagraph: true,
  });
}

function drainChunks(chunker: EmbeddedBlockChunker, force = false) {
  const chunks: string[] = [];
  chunker.drain({ force, emit: (chunk) => chunks.push(chunk) });
  return chunks;
}

function expectChunksWithinLength(chunks: string[], maxLength: number) {
  expect(
    chunks
      .map((chunk, index) => ({ index, length: chunk.length }))
      .filter((entry) => entry.length > maxLength),
  ).toStrictEqual([]);
}

describe("EmbeddedBlockChunker", () => {
  it("preserves the paragraph separator across separate flushed chunks (#42106)", () => {
    // A reply split into more than one block-streamed delivery must stay
    // Markdown-equivalent when a client concatenates the deliveries.
    const chunker = createFlushOnParagraphChunker({ minChars: 1, maxChars: 200 });
    chunker.append("# Title\n\nFirst paragraph.\n\nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBeGreaterThan(1);
    // Concatenating the streamed deliveries reconstructs the original text,
    // blank-line paragraph boundaries included.
    expect(chunks.join("")).toBe("# Title\n\nFirst paragraph.\n\nSecond paragraph.");
    // No delivery is just whitespace.
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps paragraph-boundary chunks within maxChars including the separator (#94216)", () => {
    // Exact-boundary repro: a paragraph whose length equals maxChars must not
    // emit `chunk + "\n\n"` (which would exceed maxChars). With maxChars 10 and
    // "abcdefghij\n\nRest", the paragraph fast path must not emit a 12-char
    // chunk; it falls through to the size-split path, which respects the bound.
    const chunker = createFlushOnParagraphChunker({ minChars: 1, maxChars: 10 });
    chunker.append("abcdefghij\n\nRest");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // No emitted chunk may exceed the delivery bound, separator included.
    expectChunksWithinLength(chunks, 10);
    // No content is lost when the over-limit paragraph falls back to size splitting.
    expect(chunks.join("")).toContain("abcdefghij");
    expect(chunks.join("")).toContain("Rest");
  });

  it("breaks at paragraph boundary right after fence close", () => {
    // A closed fence is a safe boundary; splitting before it would corrupt
    // markdown rendered by downstream clients.
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 40,
      breakPreference: "paragraph",
    });

    const text = [
      "Intro",
      "```js",
      "console.log('x')",
      "```",
      "",
      "After first line",
      "After second line",
    ].join("\n");

    chunker.append(text);

    const chunks = drainChunks(chunker);

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("console.log");
    // The chunk still ends at the closed fence (never mid-fence) and now carries
    // the trailing paragraph boundary it ended at so successive deliveries
    // reconstruct the "\n\n" separator (#42106).
    expect(chunks[0]).toMatch(/```\n\n$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });

  it("waits until minChars before flushing paragraph boundaries when flushOnParagraph is set", () => {
    const chunker = createFlushOnParagraphChunker({ minChars: 30, maxChars: 200 });

    chunker.append("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["First paragraph.\n\nSecond paragraph.\n\n"]);
    expect(chunker.bufferedText).toBe("Third paragraph.");
  });

  it("still force flushes buffered paragraphs below minChars at the end", () => {
    const chunker = createFlushOnParagraphChunker({ minChars: 100, maxChars: 200 });

    chunker.append("First paragraph.\n \nSecond paragraph.");

    expect(drainChunks(chunker)).toStrictEqual([]);
    expect(drainChunks(chunker, true)).toEqual(["First paragraph.\n \nSecond paragraph."]);
    expect(chunker.bufferedText).toBe("");
  });

  it("falls back to maxChars when flushOnParagraph is set and no paragraph break exists", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijKLMNOP");

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["abcdefghij"]);
    expect(chunker.bufferedText).toBe("KLMNOP");
  });

  it("clamps long paragraphs to maxChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijk\n\nRest");

    const chunks = drainChunks(chunker);

    expectChunksWithinLength(chunks, 10);
    // "abcdefghij" is a maxChars clamp (no boundary). "k" ends at the paragraph
    // break, so post-fix (#42106) it carries the consumed "\n\n".
    expect(chunks).toEqual(["abcdefghij", "k\n\n"]);
    // The clamped body still respects maxChars; only the boundary chunk gains
    // the 2-char separator appended after the size decision.
    expect(chunks[0].length).toBeLessThanOrEqual(10);
    expect(chunker.bufferedText).toBe("Rest");
  });

  it("ignores paragraph breaks inside fences when flushOnParagraph is set", () => {
    // Blank lines inside fenced code are content, not paragraph boundaries.
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    const text = [
      "Intro",
      "```js",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After fence",
    ].join("\n");

    chunker.append(text);

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n"]);
    expect(chunker.bufferedText).toBe("After fence");
  });

  it("parses fence spans once per drain call for long fenced buffers", () => {
    // Long streaming buffers should not rescan fences for every emitted chunk.
    const parseSpy = vi.spyOn(fences, "parseFenceSpans");
    const chunker = new EmbeddedBlockChunker({
      minChars: 20,
      maxChars: 80,
      breakPreference: "paragraph",
    });

    chunker.append(`\`\`\`txt\n${"line\n".repeat(600)}\`\`\``);
    const chunks = drainChunks(chunker);

    expect(chunks.length).toBeGreaterThan(2);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    parseSpy.mockRestore();
  });

  it("does not split inside the closing fence marker when clamping at maxChars", () => {
    // Clamp-based splitting rewraps fenced chunks so no partial closing marker
    // leaks into the stream.
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 30,
      breakPreference: "paragraph",
    });

    chunker.append(`\`\`\`txt\n${"a".repeat(80)}\n\`\`\``);
    const chunks = drainChunks(chunker, true);

    expect(chunks).toStrictEqual([
      `\`\`\`txt\n${"a".repeat(23)}\n\`\`\`\n`,
      `\`\`\`txt\n${"a".repeat(30)}\n\`\`\`\n`,
      `\`\`\`txt\n${"a".repeat(27)}\n\`\`\`\n`,
      "```txt\n```",
    ]);
    for (const chunk of chunks) {
      expect(chunk.startsWith("```txt")).toBe(true);
      expect(chunk.match(/```/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(chunk).not.toContain("``\n```");
    }
  });
});
