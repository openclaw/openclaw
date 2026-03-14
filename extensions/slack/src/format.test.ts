import { describe, expect, it } from "vitest";
import {
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnWithTables,
  normalizeSlackOutboundText,
} from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

describe("markdownToSlackMrkdwn", () => {
  it("handles core markdown formatting conversions", () => {
    const cases = [
      ["converts bold from double asterisks to single", "**bold text**", "*bold text*"],
      ["preserves italic underscore format", "_italic text_", "_italic text_"],
      [
        "converts strikethrough from double tilde to single",
        "~~strikethrough~~",
        "~strikethrough~",
      ],
      [
        "renders basic inline formatting together",
        "hi _there_ **boss** `code`",
        "hi _there_ *boss* `code`",
      ],
      ["renders inline code", "use `npm install`", "use `npm install`"],
      ["renders fenced code blocks", "```js\nconst x = 1;\n```", "```\nconst x = 1;\n```"],
      [
        "renders links with Slack mrkdwn syntax",
        "see [docs](https://example.com)",
        "see <https://example.com|docs>",
      ],
      ["does not duplicate bare URLs", "see https://example.com", "see https://example.com"],
      ["escapes unsafe characters", "a & b < c > d", "a &amp; b &lt; c &gt; d"],
      [
        "preserves Slack angle-bracket markup (mentions/links)",
        "hi <@U123> see <https://example.com|docs> and <!here>",
        "hi <@U123> see <https://example.com|docs> and <!here>",
      ],
      ["escapes raw HTML", "<b>nope</b>", "&lt;b&gt;nope&lt;/b&gt;"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders bullet lists", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["renders headings as bold text", "# Title", "*Title*"],
      ["renders blockquotes", "> Quote", "> Quote"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToSlackMrkdwn(input), name).toBe(expected);
    }
  });

  it("handles nested list items", () => {
    const res = markdownToSlackMrkdwn("- item\n  - nested");
    // markdown-it correctly parses this as a nested list
    expect(res).toBe("• item\n  • nested");
  });

  it("handles complex message with multiple elements", () => {
    const res = markdownToSlackMrkdwn(
      "**Important:** Check the _docs_ at [link](https://example.com)\n\n- first\n- second",
    );
    expect(res).toBe(
      "*Important:* Check the _docs_ at <https://example.com|link>\n\n• first\n• second",
    );
  });

  it("does not throw when input is undefined at runtime", () => {
    expect(markdownToSlackMrkdwn(undefined as unknown as string)).toBe("");
  });
});

describe("escapeSlackMrkdwn", () => {
  it("returns plain text unchanged", () => {
    expect(escapeSlackMrkdwn("heartbeat status ok")).toBe("heartbeat status ok");
  });

  it("escapes slack and mrkdwn control characters", () => {
    expect(escapeSlackMrkdwn("mode_*`~<&>\\")).toBe("mode\\_\\*\\`\\~&lt;&amp;&gt;\\\\");
  });
});

describe("normalizeSlackOutboundText", () => {
  it("normalizes markdown for outbound send/update paths", () => {
    expect(normalizeSlackOutboundText(" **bold** ")).toBe("*bold*");
  });
});

describe("markdownToSlackMrkdwnWithTables", () => {
  it("extracts table data in block mode", () => {
    const md = "Here is a table:\n\n| Name | Age |\n|------|-----|\n| Alice | 30 |\n\nDone.";
    const result = markdownToSlackMrkdwnWithTables(md, 4000, { tableMode: "block" });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.headers).toEqual(["Name", "Age"]);
    expect(result.tables[0]?.rows).toEqual([["Alice", "30"]]);
    // Text should still contain surrounding content
    expect(result.chunks.join("")).toContain("Here is a table");
    expect(result.chunks.join("")).toContain("Done.");
  });

  it("returns no tables in non-block modes", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = markdownToSlackMrkdwnWithTables(md, 4000, { tableMode: "code" });
    expect(result.tables).toEqual([]);
    // Table should be rendered as code
    expect(result.chunks.join("")).toContain("```");
  });

  it("handles message with no tables in block mode", () => {
    const md = "Just some **text** here.";
    const result = markdownToSlackMrkdwnWithTables(md, 4000, { tableMode: "block" });
    expect(result.tables).toEqual([]);
    expect(result.chunks.join("")).toContain("Just some");
  });

  it("handles multiple tables in block mode", () => {
    const md = "| A |\n|---|\n| 1 |\n\nSome text\n\n| B |\n|---|\n| 2 |";
    const result = markdownToSlackMrkdwnWithTables(md, 4000, { tableMode: "block" });
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0]?.headers).toEqual(["A"]);
    expect(result.tables[1]?.headers).toEqual(["B"]);
  });
});
