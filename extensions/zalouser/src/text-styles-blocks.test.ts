import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle, type Style } from "./zca-constants.js";

const { Bold, Big, Indent, UnorderedList, Red, Underline, Italic } = TextStyle;

function range(start: number, len: number, st: Style["st"], indentSize?: number) {
  return { start, len, st, ...(indentSize === undefined ? {} : { indentSize }) };
}

function expectText(input: string, text: string) {
  expect(parseZalouserTextStyles(input).text).toBe(text);
}

function expectParsed(input: string, text: string, styles: ReturnType<typeof range>[] = []) {
  expect(parseZalouserTextStyles(input)).toEqual({ text, styles });
}

describe("parseZalouserTextStyles blocks", () => {
  it("maps headings, block quotes, and lists into line styles", () => {
    expectParsed(["# Title", "> quoted", "  - nested"].join("\n"), "Title\nquoted\nnested", [
      range(0, 5, Bold),
      range(0, 5, Big),
      range(6, 6, Indent, 1),
      range(13, 6, UnorderedList),
    ]);
    expectParsed("#   title", "  title", [range(0, 7, Bold), range(0, 7, Big)]);
    expectParsed(">   quoted", "  quoted", [range(0, 8, Indent, 1)]);
  });

  it("preserves optional closing ATX hashes as heading text", () => {
    expectParsed("# title #", "title #", [range(0, 7, Bold), range(0, 7, Big)]);
    expectParsed("# ![](/img)", "![](/img)", [range(0, 9, Bold), range(0, 9, Big)]);
    expectParsed("![](/img)\n---", "![](/img)\n---");
  });

  it("keeps container-only nested blockquotes empty", () => {
    expectParsed("> >", "");
    expectParsed("- >", "-", [range(0, 1, Indent, 1)]);
    expectParsed("> -", "-", [range(0, 1, Indent, 1)]);
    expectText("> first\n>", "first\n");
    expectText("> first\n>\n", "first\n\n");
  });

  it("classifies a long blockquote-marker line in linear time", () => {
    // The blockquote-only check ended each repetition with `[ \t]?` while the
    // next began with ` {0,3}`, so either side could claim a space and a line
    // that failed to match degraded superlinearly through this entry point,
    // which formats outgoing message text. Keep the marker count modest so a
    // reintroduced ambiguity still finishes and reports instead of hanging.
    const input = `${"> ".repeat(28)}x\nquoted`;
    const startedAt = performance.now();
    expect(parseZalouserTextStyles(input).text).toContain("x");
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  it("keeps closed-fence whitespace-only payload lines byte-for-byte", () => {
    expectParsed("```\n   \n```", "\u00A0\u00A0\u00A0");
    expectParsed("```\ncode\n\n```", "code\n");
    expectParsed("```\ncode\n\n```\n**next**", "code\n\nnext", [range(6, 4, Bold)]);
    expectParsed("- ```\n  ```", "");
    expectParsed("> ```\n> ```", "");
    expect(parseZalouserTextStyles("- ```\n    \n  ```").text).not.toContain("```");
  });

  it("keeps unclosed fenced text inside its parser-owned containers", () => {
    expectParsed("- ```\n  code", "```\ncode", [range(0, 8, UnorderedList)]);
    expectParsed("> ```\n> code", "```\ncode", [range(0, 3, Indent, 1), range(4, 4, Indent, 1)]);
    expectParsed("```\n> literal", "```\n> literal");
    expectParsed("-\t```\n    code", "```\ncode", [range(0, 8, UnorderedList)]);
    expectText("- ```\n  - literal", "```\n- literal");
    expectText("   - ```\n     code", "```\ncode");
    expectText(">   ```\n>   code", "  ```\ncode");
    expectText(">\t```\n>\tcode", "  ```\ncode");
    expectParsed("- ```", "```", [range(0, 3, UnorderedList)]);
    expectParsed("```\n", "```\n");
    expectParsed("> ```", "```", [range(0, 3, Indent, 1)]);
    expectParsed("- parent\n  - ```", "parent\n```", [
      range(0, 6, UnorderedList),
      range(7, 3, Indent, 1),
      range(7, 3, UnorderedList),
    ]);
    expectParsed("> ```\n>    ", `\`\`\`\n${"\u00A0".repeat(3)}`, [
      range(0, 3, Indent, 1),
      range(4, 3, Indent, 1),
    ]);
    expectParsed("> ```\n> a\n> b", "```\na\nb", [
      range(0, 3, Indent, 1),
      range(4, 1, Indent, 1),
      range(6, 1, Indent, 1),
    ]);
    const nestedNbsp = parseZalouserTextStyles("- parent\n  - ```\n    \u00A0");
    expect(
      nestedNbsp.styles.filter((style) => style.st === Indent).map((style) => style.indentSize),
    ).toEqual([1, 1]);
  });
});

describe("parseZalouserTextStyles containers", () => {
  it("keeps parent list ownership after a nested child", () => {
    expectParsed("- parent\n  - child\n\n  continuation", "parent\nchild\ncontinuation", [
      range(0, 6, UnorderedList),
      range(7, 5, Indent, 1),
      range(7, 5, UnorderedList),
      range(13, 12, UnorderedList),
    ]);
  });

  it("keeps task fallback when the checkbox starts on a continuation line", () => {
    expectParsed("-\n  [ ] child", "[ ] child");
  });

  it("keeps unsupported top-level blocks outside the preceding list", () => {
    expectParsed("- item\n##### heading", "item\n##### heading", [range(0, 4, UnorderedList)]);
    expectText("- - -\nnext", "- - -\nnext");
    expectParsed("- item\n***", "item\n***", [range(0, 4, UnorderedList)]);
  });

  it("keeps reconstructed heading markers inside their containers", () => {
    expectParsed("> ##### literal", "##### literal", [range(0, 13, Indent, 1)]);
    expectParsed("- title\n  ---", "title\n---", [range(0, 9, UnorderedList)]);
  });

  it("preserves padding on marker-only literal headings", () => {
    expectParsed("  #", "  #");
    expectParsed("  #####", "  #####");
    expectParsed("# ###", "###", [range(0, 3, Bold), range(0, 3, Big)]);
    expectParsed("##### #####", "##### #####");
    expectParsed("##### ![](/img)", "##### ![](/img)");
    expectParsed("  ***\u00A0", "  ***");
  });

  it("keeps parser-owned indentation on marker-only nested items", () => {
    expectParsed("- -", "-", [range(0, 1, Indent, 1)]);
    expectParsed("> - -", "-", [range(0, 1, Indent, 1)]);
    expectParsed("- > -", "-", [range(0, 1, Indent, 2)]);
    expect(
      parseZalouserTextStyles("-\n  -\n    -\n      -\n        -\n          -\n            -"),
    ).toEqual({
      text: "-",
      styles: [range(0, 1, Indent, 5)],
    });
  });

  it("retains virtual tab columns beyond list indentation", () => {
    expectText("- parent\n\t##### literal", "parent\n  ##### literal");
    expectText("10. >\t##### literal", "  ##### literal");
    expectText(">\t- ##### literal", "##### literal");
    expectText(">\t>\t##### literal", "  ##### literal");
    expectText("- parent\n\t> ##### literal", "parent\n##### literal");
    expectText("> 1.\tparent\n>       ##### literal", "parent\n##### literal");
    expect(parseZalouserTextStyles("-\t  code\n\n    ##### literal").text).toContain(
      "  ##### literal",
    );
  });

  it("keeps Unicode separators inside native list content", () => {
    expectParsed("- \u00A0item", "\u00A0item", [range(0, 5, UnorderedList)]);
    expectParsed("- \u00A0", "\u00A0", [range(0, 1, UnorderedList)]);
    expectParsed("-\n  \u00A0", "\u00A0", [range(0, 1, UnorderedList)]);
    expectParsed("- parent\n  - \u00A0", "parent\n\u00A0", [
      range(0, 6, UnorderedList),
      range(7, 1, Indent, 1),
      range(7, 1, UnorderedList),
    ]);
    expectParsed("> \u00A0", "\u00A0", [range(0, 1, Indent, 1)]);
  });

  it("keeps whitespace-only lines inside indented code blocks", () => {
    expectParsed(
      "    a\n      \n    b",
      `${"\u00A0".repeat(4)}a\n${"\u00A0".repeat(6)}\n${"\u00A0".repeat(4)}b`,
    );
    const nestedCode = parseZalouserTextStyles("- parent\n  - child\n\n        code");
    expect(
      nestedCode.styles
        .filter((style) => style.st === Indent)
        .every((style) => style.indentSize === 1),
    ).toBe(true);
    const nestedNbspCode = parseZalouserTextStyles("- parent\n  - child\n\n        \u00A0");
    expect(
      nestedNbspCode.styles
        .filter((style) => style.st === Indent)
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
        range(0, 1, Bold),
        range(0, 1, Red),
        range(2, 1, Red),
        range(2, 1, Bold),
        range(4, 1, Underline),
        range(6, 3, Red),
        range(6, 3, Italic),
      ],
    });
  });

  it("treats small text tags as normal text", () => {
    expectParsed("{small}tiny{/small}", "tiny");
  });
});
