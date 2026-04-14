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
    expect(chunks[0]).toMatch(/```\n?$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });

  it("waits until minChars before flushing paragraph boundaries when flushOnParagraph is set", () => {
    const chunker = createFlushOnParagraphChunker({ minChars: 30, maxChars: 200 });

    chunker.append("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");

    const chunks = drainChunks(chunker);

    expect(chunks).toEqual(["First paragraph.\n\nSecond paragraph."]);
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
    expect(chunks).toEqual(["abcdefghij", "k"]);
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

    expect(chunks).toEqual(["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(chunker.bufferedText).toBe("After fence");
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

  describe("table protection", () => {
    it("does not split inside a markdown table with separator row", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      });

      const table = [
        "| Header 1 | Header 2 |",
        "|----------|----------|",
        "| Cell 1   | Cell 2   |",
      ].join("\n");
      const text = `Intro text.\n\n${table}\n\nAfter table.`;

      chunker.append(text);
      const chunks = drainChunks(chunker);

      const tableChunk = chunks.find((c) => c.includes("|---"));
      expect(tableChunk).toBeDefined();
      expect(tableChunk).toContain("| Header 1");
      expect(tableChunk).toContain("| Cell 1");
    });

    it("does not split a partial table without separator row", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 25,
        breakPreference: "paragraph",
      });

      const table = ["| a | b |", "| c | d |", "| e | f |"].join("\n");

      chunker.append(table);
      const chunks = drainChunks(chunker);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("| a | b |");
      expect(chunks[0]).toContain("| e | f |");
    });

    it("breaks at paragraph boundary after a table", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      });

      const table = ["| H1 | H2 |", "|----|----|", "| v1 | v2 |"].join("\n");
      const after = "Summary text after table.";
      const text = `${table}\n\n${after}`;

      chunker.append(text);
      const chunks = drainChunks(chunker);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const first = chunks[0];
      expect(first).toContain("| H1 |");
      expect(first).toContain("| v1 |");
      expect(first).not.toContain("Summary");
    });

    it("keeps table intact during streaming when buffer ends mid-table", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 40,
        breakPreference: "paragraph",
      });

      chunker.append("| Name | Age |\n| Alice | 30 |");
      const chunks = drainChunks(chunker);

      expect(chunks).toHaveLength(0);
      expect(chunker.bufferedText).toContain("| Name");
    });

    it("allows splitting shell pipe commands normally", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 30,
        breakPreference: "paragraph",
      });

      const text = [
        'cat file.txt | grep "error" | sort',
        'ps aux | grep python | awk "{print $2}"',
      ].join("\n");

      chunker.append(text);
      const chunks = drainChunks(chunker);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("force drains a table intact when table fits in maxChars", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      });

      const table = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      chunker.append(table);
      const chunks = drainChunks(chunker, true);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("| A | B |");
      expect(chunks[0]).toContain("| 1 | 2 |");
    });

    it("extends break to table end when maxChars lands inside a table (tail-skip)", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 25,
        breakPreference: "paragraph",
      });

      const table = ["| H1 | H2 |", "|----|----|", "| ab | cd |"].join("\n");

      chunker.append(table);
      const chunks = drainChunks(chunker, true);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const first = chunks[0];
      expect(first).toContain("| H1 |");
      expect(first).toContain("| ab |");
    });

    it("protects both fence and table in the same buffer", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 120,
        breakPreference: "paragraph",
      });

      const fenceBlock = "```js\nconsole.log('hello');\n```";
      const table = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      const text = `${fenceBlock}\n\n${table}\n\nAfter both.`;

      chunker.append(text);
      const chunks = drainChunks(chunker);

      const first = chunks[0];
      expect(first).toContain("console.log");
      expect(first).toContain("| A | B |");
      expect(first).toContain("| 1 | 2 |");
      expect(first).not.toContain("After both");
    });

    it("hard cuts an oversized table exceeding maxChars * 2", () => {
      const maxChars = 30;
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars,
        breakPreference: "paragraph",
      });

      const rows = Array.from({ length: 20 }, (_, i) => `| row${i} | value${i} |`);
      const hugeTable = rows.join("\n");

      chunker.append(hugeTable);
      const chunks = drainChunks(chunker, true);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(maxChars * 3);
      }
    });

    it("keeps partial table intact across multiple append calls", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 100,
        maxChars: 200,
        breakPreference: "paragraph",
      });

      chunker.append("| H1 | H2 |\n");
      chunker.append("|----|----|\n");
      chunker.append("| v1 | v2 |");
      const chunks = drainChunks(chunker, true);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain("| H1 | H2 |");
      expect(chunks[0]).toContain("| v1 | v2 |");
    });

    it("protects table with sentence break preference", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 60,
        breakPreference: "sentence",
      });

      const table = [
        "| Header 1 | Header 2 |",
        "|----------|----------|",
        "| Cell 1   | Cell 2   |",
      ].join("\n");
      const text = `Intro.\n\n${table}\n\nDone.`;

      chunker.append(text);
      const chunks = drainChunks(chunker);

      const tableChunk = chunks.find((c) => c.includes("|---"));
      expect(tableChunk).toBeDefined();
      expect(tableChunk).toContain("| Header 1");
      expect(tableChunk).toContain("| Cell 1");
    });

    it("does not split table when flushOnParagraph is enabled", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
        flushOnParagraph: true,
      });

      const table = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
      const text = `Intro.\n\n${table}\n\nAfter.`;

      chunker.append(text);
      const chunks = drainChunks(chunker);

      const tableChunk = chunks.find((c) => c.includes("|---"));
      expect(tableChunk).toBeDefined();
      expect(tableChunk).toContain("| A |");
      expect(tableChunk).toContain("| 1 |");
    });

    it("protects table with newline break preference", () => {
      const chunker = new EmbeddedBlockChunker({
        minChars: 1,
        maxChars: 60,
        breakPreference: "newline",
      });

      const table = ["| H1 | H2 |", "|----|----|", "| v1 | v2 |"].join("\n");
      const text = `Before.\n${table}\nAfter.`;

      chunker.append(text);
      const chunks = drainChunks(chunker, true);

      const tableChunk = chunks.find((c) => c.includes("|----"));
      expect(tableChunk).toBeDefined();
      expect(tableChunk).toContain("| H1 |");
      expect(tableChunk).toContain("| v1 |");
    });
  });
});
