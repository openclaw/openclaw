import { describe, expect, it } from "vitest";
import { findMarkdownCodeRegions } from "./markdown-code-regions.js";
import { findMarkdownCodeRegions as findTreeCodeRegions } from "./reasoning-tags.js";

describe("range-only Markdown ownership", () => {
  it("protects link text and unresolved image text, but not resolved image alt text", () => {
    const text = "`shown` ![`alt`](/image) [`linked`](/link) ![`pending`][id]";
    expect(findMarkdownCodeRegions(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      "`shown`",
      "`linked`",
      "`pending`",
    ]);
    expect(
      findMarkdownCodeRegions(text + "\n\n[id]: /image").map(({ start, end }) =>
        text.slice(start, end),
      ),
    ).toEqual(["`shown`", "`linked`"]);
  });

  it("retains exact raw offsets through partially expanded container tabs", () => {
    expect(findMarkdownCodeRegions(">\t\t`code`\n>\tmore")).toEqual([
      { start: 2, end: 9, block: true },
    ]);
  });

  it("keeps original CRLF offsets across inline code in a quote", () => {
    const text = "> `code\r\n> more`\r\n";
    expect(findMarkdownCodeRegions(text)).toEqual([{ start: 2, end: 16, block: false }]);
  });

  it("retains the canonical iterative grammar for deeply nested quotes", () => {
    const text = "> ".repeat(10_000) + "`<think>x</think>`";
    expect(findMarkdownCodeRegions(text)).toEqual([{ start: 20_000, end: 20_018, block: false }]);
  });

  it.each([
    "> ```xml\n> <internal>literal</internal>\n> ",
    "- item\n\n      <parameter>literal</parameter>\n\n      ",
    "| a | b |\n| - | - |\n| `a\\|b` | y |",
    '![a `<|assistant|>`][id]\n\n[id]: /image "title" x',
    '[a](/link "title `<internal>literal</internal>`")',
  ])("matches full ownership at every prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      expect(findMarkdownCodeRegions(prefix)).toEqual(findTreeCodeRegions(prefix));
    }
  });
});
