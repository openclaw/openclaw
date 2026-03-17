import { describe, expect, it } from "vitest";
import { markdownToSignalTextChunks } from "./format.js";
function expectChunkStyleRangesInBounds(chunks) {
  for (const chunk of chunks) {
    for (const style of chunk.styles) {
      expect(style.start).toBeGreaterThanOrEqual(0);
      expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
      expect(style.length).toBeGreaterThan(0);
    }
  }
}
describe("splitSignalFormattedText", () => {
  describe("style-aware splitting - basic text", () => {
    it("text with no styles splits correctly at whitespace", () => {
      const limit = 20;
      const markdown = "hello world this is a test";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
      const joinedText = chunks.map((c) => c.text).join(" ");
      expect(joinedText).toContain("hello");
      expect(joinedText).toContain("world");
      expect(joinedText).toContain("test");
    });
    it("empty text returns empty array", () => {
      const chunks = markdownToSignalTextChunks("", 100);
      expect(chunks).toEqual([]);
    });
    it("text under limit returns single chunk unchanged", () => {
      const markdown = "short text";
      const chunks = markdownToSignalTextChunks(markdown, 100);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("short text");
    });
  });
  describe("style-aware splitting - style preservation", () => {
    it("style fully within first chunk stays in first chunk", () => {
      const limit = 30;
      const markdown = "**bold** word more words here that exceed limit";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      const firstChunk = chunks[0];
      expect(firstChunk.text).toContain("bold");
      expect(firstChunk.styles.some((s) => s.style === "BOLD")).toBe(true);
      const boldStyle = firstChunk.styles.find((s) => s.style === "BOLD");
      expect(boldStyle).toBeDefined();
      expect(boldStyle.start).toBe(0);
      expect(boldStyle.length).toBe(4);
    });
    it("style fully within second chunk has offset adjusted to chunk-local position", () => {
      const limit = 30;
      const markdown = "some filler text here **bold** at the end";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      const chunkWithBold = chunks.find((c) => c.text.includes("bold"));
      expect(chunkWithBold).toBeDefined();
      expect(chunkWithBold.styles.some((s) => s.style === "BOLD")).toBe(true);
      const boldStyle = chunkWithBold.styles.find((s) => s.style === "BOLD");
      expect(boldStyle).toBeDefined();
      const boldPos = chunkWithBold.text.indexOf("bold");
      expect(boldStyle.start).toBe(boldPos);
      expect(boldStyle.length).toBe(4);
    });
    it("style spanning chunk boundary is split into two ranges", () => {
      const limit = 15;
      const markdown = "hello **boldtexthere** end";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      const chunksWithBold = chunks.filter((c) => c.styles.some((s) => s.style === "BOLD"));
      expect(chunksWithBold.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunksWithBold) {
        for (const style of chunk.styles.filter((s) => s.style === "BOLD")) {
          expect(style.start).toBeGreaterThanOrEqual(0);
          expect(style.start + style.length).toBeLessThanOrEqual(chunk.text.length);
        }
      }
    });
    it("style starting exactly at split point goes entirely to second chunk", () => {
      const limit = 10;
      const markdown = "abcdefghi **bold**";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      const chunkWithBold = chunks.find((c) => c.styles.some((s) => s.style === "BOLD"));
      expect(chunkWithBold).toBeDefined();
      const boldStyle = chunkWithBold.styles.find((s) => s.style === "BOLD");
      expect(boldStyle).toBeDefined();
      expect(boldStyle.start).toBeGreaterThanOrEqual(0);
      expect(boldStyle.start + boldStyle.length).toBeLessThanOrEqual(chunkWithBold.text.length);
    });
    it("style ending exactly at split point stays entirely in first chunk", () => {
      const limit = 10;
      const markdown = "**bold** rest of text";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      const firstChunk = chunks[0];
      if (firstChunk.text.includes("bold")) {
        const boldStyle = firstChunk.styles.find((s) => s.style === "BOLD");
        expect(boldStyle).toBeDefined();
        expect(boldStyle.start + boldStyle.length).toBeLessThanOrEqual(firstChunk.text.length);
      }
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
    it("handles zero-length text with styles gracefully", () => {
      const chunks = markdownToSignalTextChunks("", 100);
      expect(chunks).toHaveLength(0);
    });
    it("handles text that splits exactly at limit", () => {
      const limit = 10;
      const markdown = "1234567890";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("1234567890");
    });
    it("preserves style through whitespace trimming", () => {
      const limit = 30;
      const markdown = "**bold**  some text that is longer than limit";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      const firstChunk = chunks[0];
      if (firstChunk.text.includes("bold")) {
        expect(firstChunk.styles.some((s) => s.style === "BOLD")).toBe(true);
      }
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
    it("handles chunk that starts with whitespace after split", () => {
      const limit = 15;
      const markdown = "some text **bold** at end";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      for (const chunk of chunks) {
        for (const style of chunk.styles) {
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
  describe("link expansion chunk limit", () => {
    it("does not exceed chunk limit after link expansion", () => {
      const limit = 100;
      const filler = "x".repeat(80);
      const markdown = `${filler} [link](https://example.com/very/long/path/that/will/exceed/limit)`;
      const chunks = markdownToSignalTextChunks(markdown, limit);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
    });
    it("handles multiple links near chunk boundary", () => {
      const limit = 100;
      const filler = "x".repeat(60);
      const markdown = `${filler} [a](https://a.com) [b](https://b.com) [c](https://c.com)`;
      const chunks = markdownToSignalTextChunks(markdown, limit);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
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
      const markdown = "**bold start** text [link](https://example.com/path) _italic_ more content here to force chunking";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      expect(chunks.length).toBeGreaterThan(1);
      expectChunkStyleRangesInBounds(chunks);
      const allStyles = chunks.flatMap((c) => c.styles.map((s) => s.style));
      expect(allStyles).toContain("BOLD");
      expect(allStyles).toContain("ITALIC");
    });
    it("multiple links near chunk boundary all get properly chunked", () => {
      const limit = 50;
      const markdown = "[first](https://first.com/long/path) [second](https://second.com/another/path) [third](https://third.com)";
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
      const markdown = "||secret content|| and [link](https://example.com/path) with more text to chunk";
      const chunks = markdownToSignalTextChunks(markdown, limit);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(limit);
      }
      const chunkWithSpoiler = chunks.find((c) => c.styles.some((s) => s.style === "SPOILER"));
      expect(chunkWithSpoiler).toBeDefined();
      const spoilerStyle = chunkWithSpoiler.styles.find((s) => s.style === "SPOILER");
      expect(spoilerStyle).toBeDefined();
      expect(spoilerStyle.start).toBeGreaterThanOrEqual(0);
      expect(spoilerStyle.start + spoilerStyle.length).toBeLessThanOrEqual(
        chunkWithSpoiler.text.length
      );
    });
  });
});
