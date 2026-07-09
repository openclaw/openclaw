// Telegram tests cover progress text clipping behavior.
import { describe, expect, it } from "vitest";
import { clipTelegramProgressText, TELEGRAM_PROGRESS_MAX_CHARS } from "./truncate.js";

describe("clipTelegramProgressText", () => {
  it("drops a surrogate-pair emoji whole when it straddles the grapheme limit", () => {
    // 😀 is U+1F600 (1 grapheme cluster, 2 UTF-16 code units).
    // 299 'a's + 😀 = 300 grapheme clusters — fits exactly.
    // Adding a tail pushes it over 300, and the emoji is the 300th grapheme
    // cluster, which sits at/over the cut edge. Grapheme-aware truncation
    // drops it whole rather than splitting its surrogate pair.
    const base = "a".repeat(TELEGRAM_PROGRESS_MAX_CHARS - 1); // 299 'a's
    const out = clipTelegramProgressText(`${base}😀tail`);
    expect(out).toBe(`${base}…`);
    // No dangling high surrogate (high not followed by a low surrogate).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("keeps a multi-codepoint grapheme cluster that fits entirely before the cut", () => {
    // 296 'a's = 296 grapheme clusters.
    // 👨‍👩‍👧‍👦 = 1 ZWJ grapheme cluster (11 UTF-16 code units).
    // 296 + 1 = 297 < 300 — fits entirely, no truncation.
    const base = "a".repeat(TELEGRAM_PROGRESS_MAX_CHARS - 4); // 296 'a's
    const multiCp = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // 👨‍👩‍👧‍👦
    const out = clipTelegramProgressText(`${base}${multiCp}xyz`);
    // Grapheme count: 296 + 1 + 1 + 1 + 1 = 300 grapheme clusters.
    // 300 ≤ 300 → fits → full string returned.
    expect(out).toBe(`${base}${multiCp}xyz`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });

  it("returns text unchanged when it is within the limit", () => {
    const short = "hello 😀 world";
    expect(clipTelegramProgressText(short)).toBe(short);
  });

  it("trims trailing whitespace before the ellipsis", () => {
    // The sliced portion may end in spaces when trailing spaces straddle the cut.
    const text = `${"a".repeat(TELEGRAM_PROGRESS_MAX_CHARS - 2)}  rest`;
    const out = clipTelegramProgressText(text);
    expect(out).not.toContain("  …");
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles plain ASCII that fills exactly to the limit", () => {
    const exact = "x".repeat(TELEGRAM_PROGRESS_MAX_CHARS);
    expect(clipTelegramProgressText(exact)).toBe(exact);
    const oneOver = `${"x".repeat(TELEGRAM_PROGRESS_MAX_CHARS)}y`;
    const out = clipTelegramProgressText(oneOver);
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_PROGRESS_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});
