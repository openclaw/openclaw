import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { markdownToSignalTextChunks } from "./format.js";

function expectChunkStyleRangesInBounds(chunks: ReturnType<typeof markdownToSignalTextChunks>) {
  for (const chunk of chunks) {
    for (const style of chunk.styles) {
      expect(style.start).toBeGreaterThanOrEqual(0);
      expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
      expect(style.length).toBeGreaterThan(0);
    }
  }
}

type SignalTextChunk = ReturnType<typeof markdownToSignalTextChunks>[number];
type SignalTextStyle = SignalTextChunk["styles"][number];

function requireFirstChunk(chunks: ReturnType<typeof markdownToSignalTextChunks>): SignalTextChunk {
  return expectDefined(chunks[0], "first Signal text chunk");
}

function requireChunkWithStyle(
  chunks: ReturnType<typeof markdownToSignalTextChunks>,
  styleName: SignalTextStyle["style"],
): SignalTextChunk {
  const chunk = chunks.find((candidate) =>
    candidate.styles.some((style) => style.style === styleName),
  );
  if (!chunk) {
    throw new Error(`chunk with ${styleName} style missing`);
  }
  return chunk;
}

function requireStyle(chunk: SignalTextChunk, styleName: SignalTextStyle["style"]) {
  const style = chunk.styles.find((candidate) => candidate.style === styleName);
  if (!style) {
    throw new Error(`${styleName} style missing`);
  }
  return style;
}

describe("Signal style-aware chunking", () => {
  describe("style-aware splitting - basic text", () => {
    it("empty text returns empty array", () => {
      const chunks = markdownToSignalTextChunks("", 100);
      expect(chunks).toStrictEqual([]);
    });
  });

  describe("style-aware splitting - style preservation", () => {
    it("style fully within first chunk stays in first chunk", () => {
      const limit = 30;
      const markdown = "**bold** word more words here that exceed limit";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);
      const firstChunk = requireFirstChunk(chunks);
      expect(firstChunk.text).toContain("bold");
      expect(firstChunk.styles.map((style) => style.style)).toContain("BOLD");
      const boldStyle = requireStyle(firstChunk, "BOLD");
      expect(boldStyle.start).toBe(0);
      expect(boldStyle.length).toBe(4);
    });

    it("style fully within second chunk has offset adjusted to chunk-local position", () => {
      const limit = 30;
      const markdown = "some filler text here **bold** at the end";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);
      const chunkWithBold = chunks.find((c) => c.text.includes("bold"));
      if (!chunkWithBold) {
        throw new Error("chunk containing bold text missing");
      }
      expect(chunkWithBold.styles.map((style) => style.style)).toContain("BOLD");

      const boldStyle = requireStyle(chunkWithBold, "BOLD");
      const boldPos = chunkWithBold.text.indexOf("bold");
      expect(boldStyle.start).toBe(boldPos);
      expect(boldStyle.length).toBe(4);
    });

    it("multiple styles, some spanning boundary, some not", () => {
      const limit = 25;
      const markdown = "_italic_ some text **bold text** and `code`";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);

      expectChunkStyleRangesInBounds(chunks);

      const allStyles = chunks.flatMap((c) => c.styles.map((s) => s.style));
      expect(allStyles).toContain("ITALIC");
      expect(allStyles).toContain("BOLD");
      expect(allStyles).toContain("MONOSPACE");
    });
  });

  describe("style-aware splitting - edge cases", () => {
    it("handles text that splits exactly at limit", () => {
      const limit = 10;
      const markdown = "1234567890";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks).toHaveLength(1);
      expect(requireFirstChunk(chunks).text).toBe("1234567890");
    });

    it("handles repeated substrings correctly (no indexOf fragility)", () => {
      const limit = 20;
      const markdown = "word **bold word** word more text here to chunk";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      const chunksWithBold = chunks.filter((c) => c.styles.some((s) => s.style === "BOLD"));
      expect(chunksWithBold.length).toBeGreaterThanOrEqual(1);

      for (const chunk of chunksWithBold) {
        for (const style of chunk.styles.filter((s) => s.style === "BOLD")) {
          const styledText = chunk.text.slice(style.start, style.start + style.length);
          expect(styledText).toMatch(/^(bold( word)?|word)$/);
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
        }
      }
    });

    it("deterministically tracks position without indexOf fragility", () => {
      const limit = 25;
      const markdown = "aaa   **bold**   aaa   **bold**   aaa extra text to force split";
      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      for (const chunk of chunks) {
        for (const style of chunk.styles) {
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
          if (style.style === "BOLD") {
            const styledText = chunk.text.slice(style.start, style.start + style.length);
            expect(styledText).toBe("bold");
          }
        }
      }
    });
  });
});

describe("markdownToSignalTextChunks", () => {
  it("marks a transcript-role header promoted to a chunk boundary", () => {
    const header = "user[2026-07-02]";
    const chunks = markdownToSignalTextChunks(`padding padding ${header} question`, 25);
    const roleChunk = chunks.find((chunk) => chunk.text.startsWith(header));

    expect(roleChunk).toBeDefined();
    expect(roleChunk?.styles).toContainEqual({
      start: 0,
      length: header.length,
      style: "MONOSPACE",
    });
    expect(chunks.every((chunk) => chunk.text.length <= 25)).toBe(true);
  });

  it("treats Infinity as unbounded for media captions", () => {
    const markdown = "𐐀 [example.com#Install](https://example.com#install) **read**";

    const chunks = markdownToSignalTextChunks(markdown, Number.POSITIVE_INFINITY);

    const text = "𐐀 example.com#Install (https://example.com#install) read";
    expect(chunks).toEqual([
      { text, styles: [{ start: text.indexOf("read"), length: 4, style: "BOLD" }] },
    ]);
  });

  describe("link expansion chunk limit", () => {
    it("preserves case-distinct destinations and chunk-local UTF-16 styles", () => {
      const chunks = markdownToSignalTextChunks(
        "𐐀 [example.com/Report](https://example.com/report) **one**\n\n[example.com?id=AbC](https://example.com?id=abc) **two**",
        80,
      );
      const texts = [
        "𐐀 example.com/Report (https://example.com/report) one",
        "example.com?id=AbC (https://example.com?id=abc) two",
      ];
      expect(chunks).toEqual(
        texts.map((text) => ({
          text,
          styles: [{ start: text.length - 3, length: 3, style: "BOLD" }],
        })),
      );
    });
  });

  describe("link expansion with style preservation", () => {
    it("long message with links that expand beyond limit preserves all text", () => {
      const limit = 80;
      const filler = "a".repeat(50);
      const markdown = `${filler} [click here](https://example.com/very/long/path/to/page) more text`;

      const chunks = markdownToSignalTextChunks(markdown, limit);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      const combined = chunks.map((c) => c.text).join("");
      expect(combined).toContain(filler);
      expect(combined).toContain("click here");
      expect(combined).toContain("example.com");
    });

    it("styles (bold, italic) survive chunking correctly after link expansion", () => {
      const limit = 60;
      const markdown =
        "**bold start** text [link](https://example.com/path) _italic_ more content here to force chunking";

      const chunks = markdownToSignalTextChunks(markdown, limit);

      expect(chunks.length).toBeGreaterThan(1);

      expectChunkStyleRangesInBounds(chunks);

      const allStyles = chunks.flatMap((c) => c.styles.map((s) => s.style));
      expect(allStyles).toContain("BOLD");
      expect(allStyles).toContain("ITALIC");
    });

    it("multiple links near chunk boundary all get properly chunked", () => {
      const limit = 50;
      const markdown =
        "[first](https://first.com/long/path) [second](https://second.com/another/path) [third](https://third.com)";

      const chunks = markdownToSignalTextChunks(markdown, limit);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      const combined = chunks.map((c) => c.text).join("");
      expect(combined).toContain("first");
      expect(combined).toContain("second");
      expect(combined).toContain("third");
    });

    it("preserves spoiler style through link expansion and chunking", () => {
      const limit = 40;
      const markdown =
        "||secret content|| and [link](https://example.com/path) with more text to chunk";

      const chunks = markdownToSignalTextChunks(markdown, limit);

      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }

      const chunkWithSpoiler = requireChunkWithStyle(chunks, "SPOILER");

      const spoilerStyle = requireStyle(chunkWithSpoiler, "SPOILER");
      expect(spoilerStyle.start).toBeGreaterThanOrEqual(0);
      expect(spoilerStyle.start + spoilerStyle.length).toBeLessThanOrEqual(
        chunkWithSpoiler.text.length,
      );
    });
  });
});
