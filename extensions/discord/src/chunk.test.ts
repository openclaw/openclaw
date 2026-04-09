import { countLines, hasBalancedFences } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { chunkDiscordText, chunkDiscordTextWithMode } from "./chunk.js";

describe("chunkDiscordText", () => {
  it("splits tall messages even when under 2000 chars", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("keeps fenced blocks intact when chunkMode is newline", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: 2000,
      maxLines: 50,
      chunkMode: "newline",
    });
    expect(chunks).toEqual([text]);
  });

  it("reserves space for closing fences when chunking", () => {
    const body = "a".repeat(120);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkDiscordText(text, { maxChars: 14, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Each chunk should have balanced italics markers (even count).
      const count = (chunk.match(/_/g) || []).length;
      expect(count % 2).toBe(0);
    }

    // Ensure italics reopen on subsequent chunks
    expect(chunks[0]).toContain("_1. line");
    // Second chunk should reopen italics at the start
    expect(chunks[1].trimStart().startsWith("_")).toBe(true);
  });

  it("keeps reasoning italics balanced when chunks split by char limit", () => {
    const longLine = "This is a very long reasoning line that forces char splits.";
    const body = Array.from({ length: 5 }, () => longLine).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxChars: 80, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
    }
  });

  it("reopens italics while preserving leading whitespace on following chunk", () => {
    const body = [
      "1. line",
      "2. line",
      "3. line",
      "4. line",
      "5. line",
      "6. line",
      "7. line",
      "8. line",
      "9. line",
      "10. line",
      "  11. indented line",
      "12. line",
    ].join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    const second = chunks[1];
    expect(second.startsWith("_")).toBe(true);
    expect(second).toContain("  11. indented line");
  });

  it("pre-splits long blockquote lines so every physical line has > prefix", () => {
    const longBq = `> ${Array.from({ length: 6 }, () => "Short sentence here.").join(" ")}`;
    // Should be >90 chars to trigger the split
    expect(longBq.length).toBeGreaterThan(90);

    const chunks = chunkDiscordText(longBq, { maxChars: 2000, maxLines: 50 });
    // All physical lines in the output should start with "> "
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          expect(line).toMatch(/^> /);
        }
      }
    }
  });

  it("does not split short blockquote lines", () => {
    const shortBq = "> This is a short blockquote.";
    const chunks = chunkDiscordText(shortBq, { maxChars: 2000, maxLines: 50 });
    expect(chunks).toEqual([shortBq]);
  });

  it("does not split blockquote lines inside code fences", () => {
    const text = "```\n> " + "x".repeat(100) + "\n```";
    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 50 });
    expect(chunks).toEqual([text]);
  });

  it("avoids creating list markers when splitting blockquote lines", () => {
    // "- we" at the start of a blockquote line renders as a bullet in Discord
    const bq = "> Something happened gradually - we need to make sure this dash does not start a new line and get interpreted as a list bullet by Discord.";
    const chunks = chunkDiscordText(bq, { maxChars: 2000, maxLines: 50 });
    for (const chunk of chunks) {
      for (const line of chunk.split("\n")) {
        if (!line.startsWith(">")) { continue; }
        const afterPrefix = line.replace(/^>+\s?/, "");
        // Should not start with a list marker character
        expect(afterPrefix).not.toMatch(/^[-*+] /);
      }
    }
  });

  it("repeats table header in continuation chunk when code-fenced table splits", () => {
    const header = "| Name | Value | Status |";
    const sep = "| ---- | ----- | ------ |";
    const rows = Array.from({ length: 20 }, (_, i) => `| item_${i} | val_${i} | active |`).join(
      "\n",
    );
    const text = `Intro text\n\n\`\`\`\n${header}\n${sep}\n${rows}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 600, maxLines: 17 });
    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk after the first should contain the header and separator
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.includes("|")) {
        expect(chunk).toContain(header);
        expect(chunk).toContain(sep);
      }
    }

    // All chunks should have balanced fences
    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("does not repeat headers for non-table content in code fences", () => {
    const body = Array.from({ length: 20 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `\`\`\`js\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 300, maxLines: 17 });
    expect(chunks.length).toBeGreaterThan(1);

    // Second chunk should NOT contain pipe-delimited header rows
    for (let i = 1; i < chunks.length; i++) {
      const lines = chunks[i].split("\n");
      // First line after fence open should be code, not a table header
      const contentLines = lines.filter((l) => !l.startsWith("```"));
      if (contentLines.length > 0) {
        expect(contentLines[0]).toMatch(/^console\.log/);
      }
    }
  });

  it("closes and reopens bold markers when split across chunks", () => {
    const text = "Line 1\n**Bold text that\nspans multiple lines\nand should stay bold** done.";

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 2 });
    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk should have balanced ** markers
    for (const chunk of chunks) {
      const stars = (chunk.match(/\*\*/g) || []).length;
      expect(stars % 2).toBe(0);
    }
  });
});
