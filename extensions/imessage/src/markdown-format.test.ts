// Imessage tests cover markdown format plugin behavior.
import { describe, expect, it } from "vitest";
import { extractMarkdownFormatRuns } from "./markdown-format.js";

const FORMAT_CASES = [
  {
    name: "CommonMark alternate bold replaces the legacy underline dialect",
    input: "__x__",
    after: { text: "x", ranges: [{ start: 0, length: 1, styles: ["bold"] }] },
  },
  {
    name: "authored HTML u is the underline source",
    input: "<u>x</u>",
    after: { text: "x", ranges: [{ start: 0, length: 1, styles: ["underline"] }] },
  },
  {
    name: "authored HTML ins is the underline source",
    input: "<ins>x</ins>",
    after: { text: "x", ranges: [{ start: 0, length: 1, styles: ["underline"] }] },
  },
  {
    name: "inline code protects markdown-looking content and keeps its backticks",
    input: "`*x*`",
    after: { text: "`*x*`", ranges: [] },
  },
  {
    name: "intraword underscore stays literal",
    input: "snake_case",
    after: { text: "snake_case", ranges: [] },
  },
] as const;

describe("extractMarkdownFormatRuns", () => {
  it.each(FORMAT_CASES)("$name", ({ input, after }) => {
    expect(extractMarkdownFormatRuns(input)).toEqual(after);
  });

  it("renders mixed, nested, and repeated native styles in UTF-16 coordinates", () => {
    expect(extractMarkdownFormatRuns("😀 **bold _and italic_** ~~gone~~")).toEqual({
      text: "😀 bold and italic gone",
      ranges: [
        { start: 3, length: 15, styles: ["bold"] },
        { start: 8, length: 10, styles: ["italic"] },
        { start: 19, length: 4, styles: ["strikethrough"] },
      ],
    });
    expect(
      extractMarkdownFormatRuns(
        "😀\ud800 **bold `a😀` mid 😀\udfff `b` tail** then _italics `c😀` end \ud800_.",
      ),
    ).toEqual({
      text: "😀\ud800 bold `a😀` mid 😀\udfff `b` tail then italics `c😀` end \ud800.",
      ranges: [
        { start: 4, length: 27, styles: ["bold"] },
        { start: 37, length: 19, styles: ["italic"] },
      ],
    });
  });

  it("keeps literal markers that CommonMark does not treat as emphasis", () => {
    expect(extractMarkdownFormatRuns("price * quantity and **  **")).toEqual({
      text: "price * quantity and **  **",
      ranges: [],
    });
  });

  it("preserves CommonMark flanking around protected inline code", () => {
    expect(extractMarkdownFormatRuns("`code`_italic_ __Important__ (read this)")).toEqual({
      text: "`code`italic Important (read this)",
      ranges: [
        { start: 6, length: 6, styles: ["italic"] },
        { start: 13, length: 9, styles: ["bold"] },
      ],
    });
  });

  it.each([
    [
      "restores inline code containing bare carriage returns without leaking masks",
      "`*x*\rmore`",
      "`*x* more`",
    ],
    [
      "preserves multi-backtick inline code delimiters and contents",
      "Use ``a`*b*`` here",
      "Use ``a`*b*`` here",
    ],
    ["separates code content that touches a backtick delimiter", "`` ` ``", "`` ` ``"],
    ["does not cross-protect backticks inside indented code blocks", "    `abc`", "`abc`\n"],
    [
      "does not escape dunders inside fenced code blocks",
      "```python\nobj.__class__\n```",
      "obj.__class__\n",
    ],
    [
      "keeps qualified and indexed dunder identifiers literal",
      "obj.__class__ print(__name__) __dict__['key']",
      "obj.__class__ print(__name__) __dict__['key']",
    ],
  ])("%s", (_name, input, expectedText) => {
    expect(extractMarkdownFormatRuns(input)).toEqual({ text: expectedText, ranges: [] });
  });

  it("does not confuse an earlier matching bold span with a dunder call", () => {
    expect(extractMarkdownFormatRuns("**init**() then __init__()")).toEqual({
      text: "init() then __init__()",
      ranges: [{ start: 0, length: 4, styles: ["bold"] }],
    });
  });

  it("keeps dunder declarations literal after ordinary declarations", () => {
    expect(extractMarkdownFormatRuns("def init():\ndef __init__(self):")).toEqual({
      text: "def init():\ndef __init__(self):",
      ranges: [],
    });
  });

  it("preserves every repeated destination containing a dunder identifier", () => {
    expect(
      extractMarkdownFormatRuns(
        [
          "[Class][docs] and [Type][docs] **done**",
          "",
          "[docs]: https://docs.python.org/3/library/stdtypes.html#instance.__class__",
        ].join("\n"),
      ),
    ).toEqual({
      text: [
        "Class (https://docs.python.org/3/library/stdtypes.html#instance.__class__)",
        "and Type (https://docs.python.org/3/library/stdtypes.html#instance.__class__)",
        "done",
      ].join(" "),
      ranges: [{ start: 153, length: 4, styles: ["bold"] }],
    });
  });
});
