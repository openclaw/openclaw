import { describe, expect, it } from "vitest";
import { flattenMarkdownToPlainText } from "./markdown-plain-text.js";

describe("flattenMarkdownToPlainText", () => {
  it.each([
    ["fenced code blocks", "Before\n```ts\nconst hidden = true;\n```\nAfter", "Before After"],
    ["inline code", "Use `pnpm test` now", "Use pnpm test now"],
    [
      "links",
      "Read the [deployment guide](https://example.com/deploy)",
      "Read the deployment guide",
    ],
    ["images", "Status ![green check](https://example.com/check.png)", "Status green check"],
    [
      "escaped image markers before links",
      String.raw`Read \![important](https://example.com) and \\![diagram](image.png)`,
      String.raw`Read \!important and \\diagram`,
    ],
    [
      "nested link label brackets",
      "Read the [Report [Q3 [draft]]](https://example.com/r) and then deploy.",
      "Read the Report [Q3 [draft]] and then deploy.",
    ],
    [
      "balanced destination parentheses",
      "Read the [report](https://example.com/report_(Q3_(final))) and then deploy.",
      "Read the report and then deploy.",
    ],
    [
      "escaped destination parentheses",
      "Read the [report](https://example.com/report\\)Q3) and then deploy.",
      "Read the report and then deploy.",
    ],
    [
      "images with balanced destination parentheses",
      "Status ![check](https://example.com/check_(1).png) done",
      "Status check done",
    ],
    ["empty link labels", "Keep [](https://example.com) here", "Keep [](https://example.com) here"],
    ["link titles", 'See [docs](https://example.com "Docs (v2)") now', "See docs now"],
    [
      "quoted link titles with unbalanced parentheses",
      "See [docs](https://example.com \"Docs (v2\") and [guide](https://example.com 'Guide v2)') now",
      "See docs and guide now",
    ],
    ["parenthesized link titles", "See [docs](https://example.com (Docs v2)) now", "See docs now"],
    [
      "angle-bracket link destinations",
      "See [docs](<https://example.com/a b(>) now",
      "See docs now",
    ],
    [
      "linked images whose destination holds a bracket",
      "Badge [![build](https://example.com/badge[.svg)](https://ci.example.com) ok",
      "Badge build ok",
    ],
    [
      "linked images whose title holds a bracket",
      'Badge [![build](https://example.com/badge.svg "Build [main")](https://ci.example.com) ok',
      "Badge build ok",
    ],
    [
      "non-breaking spaces inside bare link destinations",
      "Read [docs](https://example.com/a b) now",
      "Read docs now",
    ],
    [
      "non-breaking spaces inside link destinations with parentheses",
      "Read [docs](https://example.com/a(b c)) now",
      "Read docs now",
    ],
    [
      "unclosed link destinations",
      "Keep [this](https://example.com/open( text",
      "Keep [this](https://example.com/open( text",
    ],
    [
      "heading and list markers",
      "# Heading\n- bullet\n+ plus\n* star\n2) numbered\n> quote",
      "Heading bullet plus star numbered quote",
    ],
    ["emphasis", "**bold** _italic_ ~~struck~~", "bold italic struck"],
    ["wider opener preference", "__a_ _b__", "a_ _b"],
    ["shorter opener fallback", "__a_", "_a"],
    ["unmatched closing marker", "_a__", "a_"],
    ["unconsumed emphasis markers", "___a___ ***b***", "_a_ *b*"],
    ["adjacent underscore spans", "_a__b_", "a_b_"],
    ["internal underscores", "_a_b_", "a_b"],
    [
      "whitespace beside emphasis markers",
      "_ x_ _x _ * x* *x * ~~ x~~",
      "_ x_ _x _ * x* *x * ~~ x~~",
    ],
    ["multiline emphasis", "_a\nb_ **c\nd** ~~e\nf~~", "a b c d e f"],
    ["astral letter boundaries", "𐐀_x_ _x_𐐀", "𐐀_x_ _x_𐐀"],
    ["emoji emphasis boundaries", "🦞_x_🦞", "🦞x🦞"],
    ["combining mark boundaries", "e\u0301_x_", "e\u0301x"],
    ["Unicode whitespace boundaries", "_\u00a0x_ _x\ufeff_", "_ x_ _x _"],
    ["literal backslashes before emphasis", "\\_x_", "\\x"],
    [
      "literal underscores and tildes",
      "Use foo_bar_baz from ~/.openclaw",
      "Use foo_bar_baz from ~/.openclaw",
    ],
    ["multiline whitespace", "First\n\n  second\t third", "First second third"],
  ])("flattens %s", (_label, input, expected) => {
    expect(flattenMarkdownToPlainText(input)).toBe(expected);
  });

  it.each(["*", "_", "~~"])("preserves repeated unmatched %s openers", (marker) => {
    const text = ` ${marker}field`.repeat(8_192);
    expect(flattenMarkdownToPlainText(text)).toBe(text.trim());
  });

  it("flattens deeply nested links without exhausting the stack", () => {
    const depth = 20_000;
    const input = `${"[".repeat(depth)}deep${"](https://example.com)".repeat(depth)} end`;
    expect(flattenMarkdownToPlainText(input)).toBe("deep end");
  });
});
