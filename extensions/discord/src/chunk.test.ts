import { countLines, hasBalancedFences } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { chunkDiscordText, chunkDiscordTextWithMode } from "./chunk.js";

function createSeededRand(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function generateRandomText(
  rand: () => number,
  opts: { chars: string[]; maxLen: number; requireNonWhitespace?: boolean },
) {
  const len = 1 + Math.floor(rand() * opts.maxLen);
  let text = "";
  let hasNonWhitespace = false;
  for (let i = 0; i < len; i++) {
    const nextChar = opts.chars[Math.floor(rand() * opts.chars.length)] ?? "a";
    text += nextChar;
    if (!/\s/.test(nextChar)) {
      hasNonWhitespace = true;
    }
  }
  if (opts.requireNonWhitespace && !hasNonWhitespace) {
    text = `${text.slice(0, -1)}a`;
  }
  return text;
}

function assertChunkBounds(chunks: string[], opts: { maxChars: number; maxLines?: number }) {
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThanOrEqual(opts.maxChars);
    if (opts.maxLines !== undefined) {
      expect(countLines(chunk)).toBeLessThanOrEqual(opts.maxLines);
    }
  }
}

describe("chunkDiscordText", () => {
  it("keeps making progress across a small randomized matrix", () => {
    const rand = createSeededRand(314159);
    const chars = ["a", "b", " ", "\n", "`", "~", "t", "x"];

    for (let i = 0; i < 12; i++) {
      const text = generateRandomText(rand, { chars, maxLen: 20 });
      const maxChars = 1 + Math.floor(rand() * 12);
      const chunks = chunkDiscordText(text, { maxChars });
      assertChunkBounds(chunks, { maxChars });
    }
  });

  it("enforces explicit maxLines across a small randomized matrix", () => {
    const rand = createSeededRand(161803);
    const chars = ["a", "b", " ", "\n", "t", "x"];

    for (let i = 0; i < 12; i++) {
      const text = generateRandomText(rand, {
        chars,
        maxLen: 24,
        requireNonWhitespace: true,
      });
      const maxChars = 6 + Math.floor(rand() * 16);
      const maxLines = 1 + Math.floor(rand() * 4);
      const chunks = chunkDiscordText(text, { maxChars, maxLines });
      assertChunkBounds(chunks, { maxChars, maxLines });
    }
  });

  it("does not split tall messages by default when under the char limit", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(1950);

    const chunks = chunkDiscordText(text);
    expect(chunks).toEqual([text]);
  });

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

  it("prefers paragraph breaks before newline or whitespace", () => {
    const text = ["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n");
    const chunks = chunkDiscordText(text, { maxChars: 75 });

    expect(chunks).toEqual([`${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n`, "c".repeat(30)]);
  });

  it("prefers newline breaks before whitespace", () => {
    const text = `alpha beta gamma\ndelta epsilon zeta`;
    const chunks = chunkDiscordText(text, { maxChars: 22 });

    expect(chunks).toEqual(["alpha beta gamma\n", "delta epsilon zeta"]);
  });

  it("does not exceed maxChars when a preferred newline break starts at the limit", () => {
    const text = `aaaaa\nbbbbb`;
    const chunks = chunkDiscordText(text, { maxChars: 5 });

    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it("does not exceed maxChars when a preferred paragraph break starts at the limit", () => {
    const text = `aaaaa\n\nbbbbb`;
    const chunks = chunkDiscordText(text, { maxChars: 5 });

    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
  });

  it("prefers whitespace breaks before arbitrary character splits", () => {
    const text = "alpha beta gamma delta";
    const chunks = chunkDiscordText(text, { maxChars: 12 });

    expect(chunks).toEqual(["alpha beta ", "gamma delta"]);
  });

  it("falls back to arbitrary splits when no better boundary exists", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = chunkDiscordText(text, { maxChars: 10 });

    expect(chunks).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"]);
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

  it("splits oversized fenced blocks while keeping each chunk balanced", () => {
    const body = "a".repeat(80);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("keeps making progress when a split lands inside a long fence opener", () => {
    const text = `\`\`\`verylonglanguagehint\nconsole.log("hi");\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8);
    }
  });

  it("does not loop when maxChars is smaller than the fence closing budget", () => {
    const text = `\`\`\`txt\nabc\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 3 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3);
    }
  });

  it("keeps making progress when a carry-over would recreate the same fence prefix", () => {
    const text = `\`\`\`txt\nabcdef\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 11 });
    expect(chunks).toEqual(["```txt\n", "abcdef\n```"]);
  });

  it("does not add an extra newline when reopening a fenced chunk at a newline boundary", () => {
    const text = `\`\`\`txt\nabc\ndefghij\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith("```txt\n\n")).toBe(false);
    }
  });

  it("closes the final chunk when an unterminated fenced block exceeds maxChars", () => {
    const text = `\`\`\`txt\n${"a".repeat(2100)}`;

    const chunks = chunkDiscordText(text, { maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("closes an unterminated fenced block that already fits once balanced", () => {
    const text = `\`\`\`txt\nabc`;

    const chunks = chunkDiscordText(text, { maxChars: 20 });
    expect(chunks).toEqual(["```txt\nabc\n```"]);
    expect(hasBalancedFences(chunks[0]!)).toBe(true);
  });

  it("does not bypass explicit maxLines when balancing a feasible unterminated fenced block", () => {
    const text = `x\n\`\`\`txt\nabc`;

    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 3 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(countLines(chunk)).toBeLessThanOrEqual(3);
    }
  });

  it("keeps explicit maxLines chunks within maxChars after reopening a malformed fence", () => {
    const text = `\`\`\`${"x".repeat(1992)}\na`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("preserves a fence opener when line mode forces progress after reopening", () => {
    const text = `\`\`\`${"x".repeat(1992)}\na`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks).toEqual([`\`\`\`${"x".repeat(1992)}\n\`\`\``, "```\na\n```"]);
    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("keeps the final balanced chunk within maxChars when closing an unterminated fence", () => {
    const text = `\`\`\`txt\n${"a".repeat(25)}\n\nrest`;

    const chunks = chunkDiscordText(text, { maxChars: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("closes a trailing unterminated fence that starts after a leading newline split", () => {
    const text = `${"a".repeat(11)}\n\`\`\`txt\nabc`;

    const chunks = chunkDiscordText(text, { maxChars: 11 });
    expect(chunks[0]).toBe("a".repeat(11));
    for (const chunk of chunks.slice(1)) {
      expect(chunk.length).toBeLessThanOrEqual(11);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("keeps a conversation-style bullet list in one chunk when under the char limit", () => {
    const text = [
      "Yeah, that framing makes sense. Plain text is the obvious fit here.",
      "",
      "Reasons this works well:",
      "- works well with editor plugins",
      "- easy to inspect and update",
      "- plain text workflow",
      "- no weird proprietary format",
      "",
      "For this, I'd use a simple text file:",
      "",
      "notes.txt",
    ].join("\n");

    expect(text.length).toBeLessThan(1950);
    expect(chunkDiscordText(text)).toEqual([text]);
  });

  it("keeps prose and a short fenced block together when the whole reply fits", () => {
    const text = [
      "Here is the command I'd use.",
      "",
      "```bash",
      "printf 'notes' > notes.txt",
      "```",
      "",
      "That keeps the workflow simple.",
    ].join("\n");

    expect(text.length).toBeLessThan(1950);
    expect(chunkDiscordText(text)).toEqual([text]);
  });

  it("splits a prose plus code block reply at the paragraph before the fenced block", () => {
    const intro = "A".repeat(120);
    const code = ["```bash", "printf 'notes' > notes.txt", "```"].join("\n");
    const outro = "B".repeat(40);
    const text = [intro, code, outro].join("\n\n");

    const chunks = chunkDiscordText(text, { maxChars: 150 });
    expect(chunks).toEqual([`${intro}\n\n`, `${code}\n\n${outro}`]);
    expect(hasBalancedFences(chunks[1])).toBe(true);
  });

  it("prefers splitting before a fenced block when the block itself fits in the next chunk", () => {
    const intro = "Opening paragraph ".repeat(8).trimEnd();
    const code = ["```bash", "echo test", "echo second", "```"].join("\n");
    const trailing = "Closing paragraph.";
    const text = [intro, code, trailing].join("\n\n");

    const chunks = chunkDiscordText(text, { maxChars: intro.length + 2 });
    expect(chunks).toEqual([`${intro}\n\n`, `${code}\n\n${trailing}`]);
  });

  it("splits long advice at paragraph boundaries instead of breaking a bullet list", () => {
    const intro = "That explanation works. Keeping the structure readable matters here.";
    const bullets = [
      "Reasons this layout is useful:",
      "- easy to scan in chat",
      "- simple to edit later",
      "- works with plain text tools",
      "- avoids unnecessary formatting",
    ].join("\n");
    const outro = ["Recommended file:", "", "notes.txt"].join("\n");
    const text = [intro, bullets, outro].join("\n\n");

    const maxChars = bullets.length + outro.length + 4;
    expect(maxChars).toBeLessThan(text.length);
    const chunks = chunkDiscordText(text, { maxChars });
    expect(chunks).toEqual([`${intro}\n\n`, `${bullets}\n\n${outro}`]);
  });

  it("prefers paragraph boundaries over an earlier whitespace break", () => {
    const intro = "alpha beta gamma delta epsilon";
    const second = "line one\nline two";
    const third = "omega";
    const text = [intro, second, third].join("\n\n");

    const chunks = chunkDiscordText(text, { maxChars: intro.length + 3 });
    expect(chunks).toEqual([`${intro}\n\n`, `${second}\n\n${third}`]);
  });

  it("keeps a short fenced block with its trailing paragraph when both fit together", () => {
    const intro = "Preface paragraph that needs its own chunk.";
    const code = ["```text", "morty", "Need edit note add links.", "```"].join("\n");
    const trailing = "Those are internal thoughts of the agent.";
    const text = [intro, code, trailing].join("\n\n");

    const expectedSecondChunk = `${code}\n\n${trailing}`;
    const maxChars = expectedSecondChunk.length;
    expect(maxChars).toBeLessThan(text.length);
    const chunks = chunkDiscordText(text, { maxChars });
    expect(chunks).toEqual([`${intro}\n\n`, expectedSecondChunk]);
  });

  it("splits inside a fenced block only when the block cannot fit in one chunk", () => {
    const code = ["```text", "morty", "a".repeat(80), "```"].join("\n");

    const chunks = chunkDiscordText(code, { maxChars: 35 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(35);
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
});
