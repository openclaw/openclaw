import { describe, expect, it } from "vitest";
import { chunkFeishuMarkdown, materializeFeishuPostMarkdownSoftBreaks } from "./markdown.js";

describe("materializeFeishuPostMarkdownSoftBreaks", () => {
  it.each([
    { name: "LF", input: "line one\nline two", expected: "line one  \nline two" },
    { name: "CRLF", input: "line one\r\nline two", expected: "line one  \r\nline two" },
    { name: "CR", input: "line one\rline two", expected: "line one  \rline two" },
  ])("materializes CommonMark soft breaks with $name endings", ({ input, expected }) => {
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(expected);
  });

  it("preserves existing paragraph breaks and is idempotent", () => {
    const once = materializeFeishuPostMarkdownSoftBreaks("a\nb\n\nc\nd");
    expect(once).toBe("a  \nb\n\nc  \nd");
    expect(materializeFeishuPostMarkdownSoftBreaks(once)).toBe(once);
  });

  it("preserves fenced and indented code source", () => {
    const input = [
      "```ts",
      "const first = 1",
      "const second = 2",
      "```",
      "",
      "    indented first",
      "    indented second",
    ].join("\n");
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(input);
  });

  it("preserves multiline inline code while materializing the following soft break", () => {
    const input = "run `const first = 1\nconst second = 2` now\nnext";
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(
      "run `const first = 1\nconst second = 2` now  \nnext",
    );
  });

  it("preserves explicit hard breaks and setext headings", () => {
    expect(materializeFeishuPostMarkdownSoftBreaks("hard  \nbreak")).toBe("hard  \nbreak");
    expect(materializeFeishuPostMarkdownSoftBreaks("Title\n=====\nnext")).toBe(
      "Title\n=====\nnext",
    );
  });

  it("preserves structural list boundaries and HTML blocks", () => {
    expect(materializeFeishuPostMarkdownSoftBreaks("- first\n- second")).toBe("- first\n- second");
    expect(materializeFeishuPostMarkdownSoftBreaks("<div>\nfirst\nsecond\n</div>")).toBe(
      "<div>\nfirst\nsecond\n</div>",
    );
  });

  it("preserves GFM table row boundaries", () => {
    const input = "| name | status |\n| --- | --- |\n| first | ready |\n| second | done |";
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(input);
  });

  it("keeps multiline inline formatting and lazy block containers intact", () => {
    expect(materializeFeishuPostMarkdownSoftBreaks("*first\nsecond*")).toBe("*first  \nsecond*");
    expect(materializeFeishuPostMarkdownSoftBreaks("> first\nsecond")).toBe("> first  \nsecond");
  });

  it("treats an unclosed fence as code through the end of the document", () => {
    const input = "```ts\nconst first = 1\nconst second = 2";
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(input);
  });
});

describe("chunkFeishuMarkdown", () => {
  it("keeps split fenced-code chunks independently parseable", () => {
    const chunks = chunkFeishuMarkdown(`\`\`\`ts\n${"const value = 1;\n".repeat(20)}\`\`\``, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("```ts") && chunk.endsWith("```"))).toBe(true);
  });
});
