import { describe, expect, it } from "vitest";
import { parseZalouserTextStyles } from "./text-styles.js";
import { TextStyle, type Style } from "./zca-constants.js";

function range(start: number, len: number, st: Style["st"], indentSize?: number) {
  return { start, len, st, ...(indentSize === undefined ? {} : { indentSize }) };
}

function expectParsed(input: string, text: string, styles: ReturnType<typeof range>[] = []) {
  expect(parseZalouserTextStyles(input)).toEqual({ text, styles });
}

describe("parseZalouserTextStyles blocks", () => {
  it("maps headings, block quotes, and lists into line styles", () => {
    expectParsed(["# Title", "> quoted", "  - nested"].join("\n"), "Title\nquoted\nnested", [
      range(0, 5, TextStyle.Bold),
      range(0, 5, TextStyle.Big),
      range(6, 6, TextStyle.Indent, 1),
      range(13, 6, TextStyle.UnorderedList),
    ]);
    expectParsed("#   title", "  title", [range(0, 7, TextStyle.Bold), range(0, 7, TextStyle.Big)]);
    expectParsed(">   quoted", "  quoted", [range(0, 8, TextStyle.Indent, 1)]);
  });

  it("preserves optional closing ATX hashes as heading text", () => {
    expectParsed("# title #", "title #", [range(0, 7, TextStyle.Bold), range(0, 7, TextStyle.Big)]);
    expectParsed("# ![](/img)", "![](/img)", [
      range(0, 9, TextStyle.Bold),
      range(0, 9, TextStyle.Big),
    ]);
    expectParsed("![](/img)\n---", "![](/img)\n---");
  });

  it("keeps container-only nested blockquotes empty", () => {
    expectParsed("> >", "");
    expectParsed("- >", "-", [range(0, 1, TextStyle.Indent, 1)]);
    expectParsed("> -", "-", [range(0, 1, TextStyle.Indent, 1)]);
    expect(parseZalouserTextStyles("> first\n>").text).toBe("first\n");
    expect(parseZalouserTextStyles("> first\n>\n").text).toBe("first\n\n");
  });

  it("keeps closed-fence whitespace-only payload lines byte-for-byte", () => {
    expectParsed("```\n   \n```", "\u00A0\u00A0\u00A0");
    expectParsed("```\ncode\n\n```", "code\n");
    expectParsed("```\ncode\n\n```\n**next**", "code\n\nnext", [range(6, 4, TextStyle.Bold)]);
    expectParsed("- ```\n  ```", "");
    expectParsed("> ```\n> ```", "");
    expect(parseZalouserTextStyles("- ```\n    \n  ```").text).not.toContain("```");
  });

  it("keeps unclosed fenced text inside its parser-owned containers", () => {
    expectParsed("- ```\n  code", "```\ncode", [range(0, 8, TextStyle.UnorderedList)]);
    expectParsed("> ```\n> code", "```\ncode", [
      range(0, 3, TextStyle.Indent, 1),
      range(4, 4, TextStyle.Indent, 1),
    ]);
    expectParsed("```\n> literal", "```\n> literal");
    expectParsed("-\t```\n    code", "```\ncode", [range(0, 8, TextStyle.UnorderedList)]);
    expect(parseZalouserTextStyles("- ```\n  - literal").text).toBe("```\n- literal");
    expect(parseZalouserTextStyles("   - ```\n     code").text).toBe("```\ncode");
    expect(parseZalouserTextStyles(">   ```\n>   code").text).toBe("  ```\ncode");
    expect(parseZalouserTextStyles(">\t```\n>\tcode").text).toBe("  ```\ncode");
    expectParsed("- ```", "```", [range(0, 3, TextStyle.UnorderedList)]);
    expectParsed("```\n", "```\n");
    expectParsed("> ```", "```", [range(0, 3, TextStyle.Indent, 1)]);
    expectParsed("- parent\n  - ```", "parent\n```", [
      range(0, 6, TextStyle.UnorderedList),
      range(7, 3, TextStyle.Indent, 1),
      range(7, 3, TextStyle.UnorderedList),
    ]);
    expectParsed("> ```\n>    ", `\`\`\`\n${"\u00A0".repeat(3)}`, [
      range(0, 3, TextStyle.Indent, 1),
      range(4, 3, TextStyle.Indent, 1),
    ]);
    expectParsed("> ```\n> a\n> b", "```\na\nb", [
      range(0, 3, TextStyle.Indent, 1),
      range(4, 1, TextStyle.Indent, 1),
      range(6, 1, TextStyle.Indent, 1),
    ]);
    const nestedNbsp = parseZalouserTextStyles("- parent\n  - ```\n    \u00A0");
    expect(
      nestedNbsp.styles
        .filter((style) => style.st === TextStyle.Indent)
        .map((style) => style.indentSize),
    ).toEqual([1, 1]);
  });
});
