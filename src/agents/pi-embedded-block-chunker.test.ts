import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

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

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("console.log");
    expect(chunks[0]).toMatch(/```\n?$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });

  it("flushes paragraph boundaries before minChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("First paragraph.\n\nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["First paragraph."]);
    expect(chunker.bufferedText).toBe("Second paragraph.");
  });

  it("treats blank lines with whitespace as paragraph boundaries when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("First paragraph.\n \nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["First paragraph."]);
    expect(chunker.bufferedText).toBe("Second paragraph.");
  });

  it("falls back to maxChars when flushOnParagraph is set and no paragraph break exists", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijKLMNOP");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

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

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks).toEqual(["abcdefghij", "k"]);
    expect(chunker.bufferedText).toBe("Rest");
  });

  it("ignores paragraph breaks inside fences when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
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

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(chunker.bufferedText).toBe("After fence");
  });
});
