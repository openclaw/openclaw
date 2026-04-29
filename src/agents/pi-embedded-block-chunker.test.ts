import { describe, expect, it, vi } from "vitest";
import * as fences from "../markdown/fences.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

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

describe("EmbeddedBlockChunker", () => {
  it("breaks at paragraph boundary right after fence close", () => {
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

    expect(drainChunks(chunker)).toEqual([]);
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

    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks).toEqual(["abcdefghij", "k\n\n"]);
    expect(chunker.bufferedText).toBe("Rest");
  });

  it("ignores paragraph breaks inside fences when flushOnParagraph is set", () => {
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

  it("preserves newline separators in raw chunks", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 12,
      breakPreference: "newline",
    });
    const text = "alpha\nbeta\ngamma";

    chunker.append(text);

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["alpha\nbeta\n"]);
    expect(chunks.join("") + chunker.bufferedText).toBe(text);
  });

  it("caps markdown table chunks when a max-char break falls inside one", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 20,
      breakPreference: "paragraph",
    });
    const text = [
      "Intro",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| Alpha | One |",
      "| Beta | Two |",
      "",
      "Outro",
    ].join("\n");

    chunker.append(text);

    const chunks = drainChunks(chunker);

    expect(chunks[0]).toBe("Intro\n\n");
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(chunks.join("") + chunker.bufferedText).toBe(text);
  });

  it("does not emit an oversized chunk for a table-only payload longer than maxChars", () => {
    const maxChars = 25;
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars,
      breakPreference: "paragraph",
    });
    const text = [
      "| Name | Description |",
      "| --- | --- |",
      `| Alpha | ${"a".repeat(70)} |`,
      `| Beta | ${"b".repeat(70)} |`,
    ].join("\n");

    chunker.append(text);

    const chunks = drainChunks(chunker, true);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("parses fence spans once per drain call for long fenced buffers", () => {
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
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 30,
      breakPreference: "paragraph",
    });

    chunker.append(`\`\`\`txt\n${"a".repeat(80)}\n\`\`\``);
    const chunks = drainChunks(chunker, true);

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.startsWith("```txt")).toBe(true);
      expect(chunk.match(/```/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(chunk).not.toContain("``\n```");
    }
  });
});
