import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle, type Style } from "./zca-constants.js";

function range(start: number, len: number, st: Style["st"], indentSize?: number) {
  return { start, len, st, ...(indentSize === undefined ? {} : { indentSize }) };
}

function expectParsed(input: string, text: string, styles: ReturnType<typeof range>[] = []) {
  expect(parseZalouserTextStyles(input)).toEqual({ text, styles });
}

describe("parseZalouserTextStyles containers", () => {
  it("keeps parent list ownership after a nested child", () => {
    expectParsed("- parent\n  - child\n\n  continuation", "parent\nchild\ncontinuation", [
      range(0, 6, TextStyle.UnorderedList),
      range(7, 5, TextStyle.Indent, 1),
      range(7, 5, TextStyle.UnorderedList),
      range(13, 12, TextStyle.UnorderedList),
    ]);
  });

  it("keeps task fallback when the checkbox starts on a continuation line", () => {
    expectParsed("-\n  [ ] child", "[ ] child");
  });

  it("keeps unsupported top-level blocks outside the preceding list", () => {
    expectParsed("- item\n##### heading", "item\n##### heading", [
      range(0, 4, TextStyle.UnorderedList),
    ]);
    expect(parseZalouserTextStyles("- - -\nnext").text).toBe("- - -\nnext");
    expectParsed("- item\n***", "item\n***", [range(0, 4, TextStyle.UnorderedList)]);
  });

  it("keeps reconstructed heading markers inside their containers", () => {
    expectParsed("> ##### literal", "##### literal", [range(0, 13, TextStyle.Indent, 1)]);
    expectParsed("- title\n  ---", "title\n---", [range(0, 9, TextStyle.UnorderedList)]);
  });

  it("preserves padding on marker-only literal headings", () => {
    expectParsed("  #", "  #");
    expectParsed("  #####", "  #####");
    expectParsed("# ###", "###", [range(0, 3, TextStyle.Bold), range(0, 3, TextStyle.Big)]);
    expectParsed("##### #####", "##### #####");
    expectParsed("##### ![](/img)", "##### ![](/img)");
    expectParsed("  ***\u00A0", "  ***");
  });

  it("keeps parser-owned indentation on marker-only nested items", () => {
    expectParsed("- -", "-", [range(0, 1, TextStyle.Indent, 1)]);
    expectParsed("> - -", "-", [range(0, 1, TextStyle.Indent, 1)]);
    expectParsed("- > -", "-", [range(0, 1, TextStyle.Indent, 2)]);
    expect(
      parseZalouserTextStyles("-\n  -\n    -\n      -\n        -\n          -\n            -"),
    ).toEqual({
      text: "-",
      styles: [range(0, 1, TextStyle.Indent, 5)],
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
    expectParsed("- \u00A0item", "\u00A0item", [range(0, 5, TextStyle.UnorderedList)]);
    expectParsed("- \u00A0", "\u00A0", [range(0, 1, TextStyle.UnorderedList)]);
    expectParsed("-\n  \u00A0", "\u00A0", [range(0, 1, TextStyle.UnorderedList)]);
    expectParsed("- parent\n  - \u00A0", "parent\n\u00A0", [
      range(0, 6, TextStyle.UnorderedList),
      range(7, 1, TextStyle.Indent, 1),
      range(7, 1, TextStyle.UnorderedList),
    ]);
    expectParsed("> \u00A0", "\u00A0", [range(0, 1, TextStyle.Indent, 1)]);
  });

  it("keeps whitespace-only lines inside indented code blocks", () => {
    expectParsed(
      "    a\n      \n    b",
      `${"\u00A0".repeat(4)}a\n${"\u00A0".repeat(6)}\n${"\u00A0".repeat(4)}b`,
    );
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
        range(0, 1, TextStyle.Bold),
        range(0, 1, TextStyle.Red),
        range(2, 1, TextStyle.Red),
        range(2, 1, TextStyle.Bold),
        range(4, 1, TextStyle.Underline),
        range(6, 3, TextStyle.Red),
        range(6, 3, TextStyle.Italic),
      ],
    });
  });

  it("treats small text tags as normal text", () => {
    expectParsed("{small}tiny{/small}", "tiny");
  });
});
