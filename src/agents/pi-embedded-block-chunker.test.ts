import { describe, expect, it } from "vitest";

import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

describe("EmbeddedBlockChunker", () => {
  it("prefers paragraph breaks right after fence close (soft break)", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10_000,
      breakPreference: "paragraph",
    });

    const text = [
      "Intro",
      "```js",
      "console.log('x')",
      "```",
      "",
      "After first line",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("console.log");
    expect(chunks[0]).toMatch(/```\n$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunks[1]).toMatch(/^After/);
  });

  it("prefers paragraph breaks right after fence close (hard break)", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10_000,
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
    expect(chunks[0]).toMatch(/```\n$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });
});
