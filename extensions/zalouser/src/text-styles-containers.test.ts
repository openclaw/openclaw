import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle } from "./zca-constants.js";

describe("parseZalouserTextStyles containers", () => {
  it("keeps parent list ownership after a nested child", () => {
    expect(parseZalouserTextStyles("- parent\n  - child\n\n  continuation")).toEqual({
      text: "parent\nchild\ncontinuation",
      styles: [
        { start: 0, len: 6, st: TextStyle.UnorderedList },
        { start: 7, len: 5, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 5, st: TextStyle.UnorderedList },
        { start: 13, len: 12, st: TextStyle.UnorderedList },
      ],
    });
  });

  it("keeps task fallback when the checkbox starts on a continuation line", () => {
    expect(parseZalouserTextStyles("-\n  [ ] child")).toEqual({
      text: "[ ] child",
      styles: [],
    });
  });

  it("keeps unsupported top-level blocks outside the preceding list", () => {
    expect(parseZalouserTextStyles("- item\n##### heading")).toEqual({
      text: "item\n##### heading",
      styles: [{ start: 0, len: 4, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- - -\nnext").text).toBe("- - -\nnext");
    expect(parseZalouserTextStyles("- item\n***")).toEqual({
      text: "item\n***",
      styles: [{ start: 0, len: 4, st: TextStyle.UnorderedList }],
    });
  });

  it("keeps reconstructed heading markers inside their containers", () => {
    expect(parseZalouserTextStyles("> ##### literal")).toEqual({
      text: "##### literal",
      styles: [{ start: 0, len: 13, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("- title\n  ---")).toEqual({
      text: "title\n---",
      styles: [{ start: 0, len: 9, st: TextStyle.UnorderedList }],
    });
  });

  it("preserves padding on marker-only literal headings", () => {
    expect(parseZalouserTextStyles("  #")).toEqual({ text: "  #", styles: [] });
    expect(parseZalouserTextStyles("  #####")).toEqual({ text: "  #####", styles: [] });
    expect(parseZalouserTextStyles("# ###")).toEqual({
      text: "###",
      styles: [
        { start: 0, len: 3, st: TextStyle.Bold },
        { start: 0, len: 3, st: TextStyle.Big },
      ],
    });
    expect(parseZalouserTextStyles("##### #####")).toEqual({
      text: "##### #####",
      styles: [],
    });
    expect(parseZalouserTextStyles("##### ![](/img)")).toEqual({
      text: "##### ![](/img)",
      styles: [],
    });
    expect(parseZalouserTextStyles("  ***\u00A0")).toEqual({ text: "  ***", styles: [] });
  });

  it("keeps parser-owned indentation on marker-only nested items", () => {
    expect(parseZalouserTextStyles("- -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("> - -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
    expect(parseZalouserTextStyles("- > -")).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 2 }],
    });
    expect(
      parseZalouserTextStyles("-\n  -\n    -\n      -\n        -\n          -\n            -"),
    ).toEqual({
      text: "-",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 5 }],
    });
  });

  it("retains virtual tab columns beyond list indentation", () => {
    expect(parseZalouserTextStyles("- parent\n\t##### literal").text).toBe(
      "parent\n  ##### literal",
    );
    expect(parseZalouserTextStyles("10. >\t##### literal").text).toBe("  ##### literal");
    expect(parseZalouserTextStyles(">\t- ##### literal").text).toBe("##### literal");
    expect(parseZalouserTextStyles(">\t>\t##### literal").text).toBe("  ##### literal");
    expect(parseZalouserTextStyles("- parent\n\t> ##### literal").text).toBe(
      "parent\n##### literal",
    );
    expect(parseZalouserTextStyles("> 1.\tparent\n>       ##### literal").text).toBe(
      "parent\n##### literal",
    );
    expect(parseZalouserTextStyles("-\t  code\n\n    ##### literal").text).toContain(
      "  ##### literal",
    );
  });

  it("keeps Unicode separators inside native list content", () => {
    expect(parseZalouserTextStyles("- \u00A0item")).toEqual({
      text: "\u00A0item",
      styles: [{ start: 0, len: 5, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- \u00A0")).toEqual({
      text: "\u00A0",
      styles: [{ start: 0, len: 1, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("-\n  \u00A0")).toEqual({
      text: "\u00A0",
      styles: [{ start: 0, len: 1, st: TextStyle.UnorderedList }],
    });
    expect(parseZalouserTextStyles("- parent\n  - \u00A0")).toEqual({
      text: "parent\n\u00A0",
      styles: [
        { start: 0, len: 6, st: TextStyle.UnorderedList },
        { start: 7, len: 1, st: TextStyle.Indent, indentSize: 1 },
        { start: 7, len: 1, st: TextStyle.UnorderedList },
      ],
    });
    expect(parseZalouserTextStyles("> \u00A0")).toEqual({
      text: "\u00A0",
      styles: [{ start: 0, len: 1, st: TextStyle.Indent, indentSize: 1 }],
    });
  });

  it("keeps whitespace-only lines inside indented code blocks", () => {
    expect(parseZalouserTextStyles("    a\n      \n    b")).toEqual({
      text: `${"\u00A0".repeat(4)}a\n${"\u00A0".repeat(6)}\n${"\u00A0".repeat(4)}b`,
      styles: [],
    });
    const nestedCode = parseZalouserTextStyles("- parent\n  - child\n\n        code");
    expect(
      nestedCode.styles
        .filter((style) => style.st === TextStyle.Indent)
        .every((style) => style.indentSize === 1),
    ).toBe(true);
    const nestedNbspCode = parseZalouserTextStyles("- parent\n  - child\n\n        \u00A0");
    expect(
      nestedNbspCode.styles
        .filter((style) => style.st === TextStyle.Indent)
        .every((style) => style.indentSize === 1),
    ).toBe(true);
  });

  it("supports nested markdown and tag styles regardless of order", () => {
    expect(
      parseZalouserTextStyles(
        '**{red}x{/red}** {red}**y**{/red} {underline}z{/underline} {red}*"q"*{/red}',
      ),
    ).toEqual({
      text: 'x y z "q"',
      styles: [
        { start: 0, len: 1, st: TextStyle.Bold },
        { start: 0, len: 1, st: TextStyle.Red },
        { start: 2, len: 1, st: TextStyle.Red },
        { start: 2, len: 1, st: TextStyle.Bold },
        { start: 4, len: 1, st: TextStyle.Underline },
        { start: 6, len: 3, st: TextStyle.Red },
        { start: 6, len: 3, st: TextStyle.Italic },
      ],
    });
  });

  it("treats small text tags as normal text", () => {
    expect(parseZalouserTextStyles("{small}tiny{/small}")).toEqual({
      text: "tiny",
      styles: [],
    });
  });
});
