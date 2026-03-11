import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-client.js";

describe("parseZalouserTextStyles", () => {
  it("renders inline markdown emphasis as Zalo style ranges", () => {
    expect(parseZalouserTextStyles("**bold** *italic* ~~strike~~")).toEqual({
      text: "bold italic strike",
      styles: [
        { start: 0, len: 4, st: TextStyle.Bold },
        { start: 5, len: 6, st: TextStyle.Italic },
        { start: 12, len: 6, st: TextStyle.StrikeThrough },
      ],
    });
  });

  it("keeps inline code and plain math markers literal", () => {
    expect(parseZalouserTextStyles("before `inline *code*` after\n2 * 3 * 4")).toEqual({
      text: "before `inline *code*` after\n2 * 3 * 4",
      styles: [],
    });
  });

  it("maps headings, block quotes, and lists into line styles", () => {
    expect(parseZalouserTextStyles(["# Title", "> quoted", "  - nested"].join("\n"))).toEqual({
      text: "Title\nquoted\nnested",
      styles: [
        { start: 0, len: 5, st: TextStyle.Bold },
        { start: 0, len: 5, st: TextStyle.Big },
        { start: 6, len: 6, st: TextStyle.Indent, indentSize: 1 },
        { start: 13, len: 6, st: TextStyle.Indent, indentSize: 1 },
        { start: 13, len: 6, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("strips fenced code markers and preserves leading indentation with nbsp", () => {
    expect(parseZalouserTextStyles("```ts\n  const x = 1\n\treturn x\n```")).toEqual({
      text: "\u00A0\u00A0const x = 1\n\u00A0\u00A0\u00A0\u00A0return x",
      styles: [],
    });
  });

  it("keeps unmatched fences literal", () => {
    expect(parseZalouserTextStyles("```python")).toEqual({
      text: "```python",
      styles: [],
    });
  });

  it("supports nested markdown and tag styles regardless of order", () => {
    expect(parseZalouserTextStyles("**{red}x{/red}** {red}**y**{/red}")).toEqual({
      text: "x y",
      styles: [
        { start: 0, len: 1, st: TextStyle.Bold },
        { start: 0, len: 1, st: TextStyle.Red },
        { start: 2, len: 1, st: TextStyle.Red },
        { start: 2, len: 1, st: TextStyle.Bold },
      ],
    });
  });

  it("treats small text tags as normal text", () => {
    expect(parseZalouserTextStyles("{small}tiny{/small}")).toEqual({
      text: "tiny",
      styles: [],
    });
  });

  it("keeps escaped markers literal", () => {
    expect(parseZalouserTextStyles("\\*literal\\* \\{underline}tag{/underline}")).toEqual({
      text: "*literal* {underline}tag{/underline}",
      styles: [],
    });
  });
});
