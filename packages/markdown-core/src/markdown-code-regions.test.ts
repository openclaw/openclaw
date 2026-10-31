import { describe, expect, it } from "vitest";
import { findMarkdownCodeRegions, findMarkdownCodeOwnership } from "./markdown-code-regions.js";
import { findMarkdownCodeRegions as findTreeCodeRegions } from "./reasoning-tag-parser.js";

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
    "\uFEFF`x`",
    "\uFEFF```js\nx\n```",
    "\uFEFF![`alt`][id]\n\n[id]: /image",
    "> ```xml\n> <internal>literal</internal>\n> ",
    "- item\n\n      <parameter>literal</parameter>\n\n      ",
    "| a | b |\n| - | - |\n| `a\\|b` | y |",
    '![a `<|assistant|>`][id]\n\n[id]: /image "title" x',
    '[a](/link "title `<internal>literal</internal>`")',
    "Use `[[reply_to_current]]` and ``a`b`` literally.\n\n~~~text\n<parameter>x</parameter>\n~~~\n",
    "  ````typescript\n```nested\n~~~tilde\n  ````  \n\n```unfinished\nbody\n",
    "before \\`escaped` and ``unmatched `paired` tail\n\nnext `paragraph`",
    "before `a\\` then `b` and \\\\`c`\r\nafter",
    "before `open\ncontinued` then `split\n\nparagraph`",
    "``` invalid `info\ntext\n```\n",
    "a `open\n:---:\nclose`",
    "Intro `x\n[tool:read] {}\nx` |\n---",
    "Intro `x\n[tool:read] {}\nx` |\n -:\n",
    "[id]: /image\n    prose `x`\n---\n![`alt`][id]",
    "> -\n\n    `x`\n    `y`",
    "- - - item\n      `x`\n\n      `y`",
    "a\n> > -\n    `x`",
    "2)  \t\r\n    \r    - ~~~info\r\n    ``a`b``\r\n",
    "![`before`][late]\n\n> [late]: /image\n\n~~~end\nbody",
  ])("matches full ownership at every prefix: %j", (text) => {
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      expect(findMarkdownCodeRegions(prefix)).toEqual(findTreeCodeRegions(prefix));
    }
  });

  it("keeps commonmark pipes in the same inline span", () => {
    const text = "| `a | b` |\n| - | - |";
    expect(findMarkdownCodeRegions(text, { syntax: "commonmark" })).toEqual(
      findTreeCodeRegions(text, { syntax: "commonmark" }),
    );
  });

  it("bounds work across deep lists, indented continuations, and blank lines", () => {
    const depth = 10_000;
    const first = "- ".repeat(depth) + "`one`\n";
    const text = first + " ".repeat(depth * 2) + "`two`\n" + "\n".repeat(depth);
    const started = performance.now();
    expect(findMarkdownCodeRegions(text)).toEqual([
      { start: depth * 2, end: depth * 2 + 5, block: false },
      { start: first.length + depth * 2, end: first.length + depth * 2 + 5, block: false },
    ]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps a dense inline paragraph below the array argument limit", () => {
    const count = 150_000;
    const regions = findMarkdownCodeRegions("`x` ".repeat(count));
    expect(regions).toHaveLength(count);
    expect(regions.at(-1)).toEqual({
      start: (count - 1) * 4,
      end: (count - 1) * 4 + 3,
      block: false,
    });
  });

  it("visits pending reference-title suffixes once across separate containers", () => {
    const count = 4_000;
    const text = Array.from({ length: count }, (_, index) => `- [a${index}]: /url\n> (\n`).join("");
    const started = performance.now();
    const ownership = findMarkdownCodeOwnership(text);
    expect(ownership.definitions).toHaveLength(count);
    expect(ownership.unsettledDefinitionStarts).toHaveLength(count);
    expect(ownership.retainStart).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("scans a 20 MiB agent response within the large-input budget", () => {
    const unit =
      "The result preserves `[[reply_to_current]]` and ``a`b`` as source.\n\n" +
      '````typescript\nconst reply = "[[reply_to_current]]";\n```nested\n~~~tilde\n````\n\n' +
      "~~~text\n<parameter>synthetic</parameter>\n~~~\n";
    const repeats = Math.ceil((20 * 1024 * 1024) / unit.length);
    const text = unit.repeat(repeats);
    const started = performance.now();
    const regions = findMarkdownCodeRegions(text);
    const elapsed = performance.now() - started;
    expect(regions).toHaveLength(repeats * 4);
    expect(regions.at(-1)).toEqual({
      start: text.length - "~~~text\n<parameter>synthetic</parameter>\n~~~\n".length,
      end: text.length - 1,
      block: true,
    });
    expect(elapsed).toBeLessThan(2_000);
  });
});
