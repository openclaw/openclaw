// Imessage tests cover markdown format plugin behavior.
import { describe, expect, it } from "vitest";
import { extractMarkdownFormatRuns } from "./markdown-format.js";

describe("extractMarkdownFormatRuns", () => {
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

  it("separates code content that touches a backtick delimiter", () => {
    expect(extractMarkdownFormatRuns("`` ` ``")).toEqual({ text: "`` ` ``", ranges: [] });
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
