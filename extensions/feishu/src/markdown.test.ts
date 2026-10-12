import { convertMarkdownTables } from "openclaw/plugin-sdk/markdown-table-runtime";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPostMessageContent,
  chunkedFencesBalance,
  chunkFeishuPostMarkdown,
  materializeFeishuPostMarkdownSoftBreaks,
} from "./markdown.js";

describe("materializeFeishuPostMarkdownSoftBreaks", () => {
  it.each([
    { name: "CRLF", input: "line one\r\nline two", expected: "line one  \r\nline two" },
    { name: "CR", input: "line one\rline two", expected: "line one  \rline two" },
  ])("materializes CommonMark soft breaks with $name endings", ({ input, expected }) => {
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(expected);
  });
});

describe("chunkedFencesBalance", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  it("reads a quoted marker past the quote's own four columns as indented code", () => {
    // Five spaces after the marker: one of them belongs to the marker, and the four that
    // remain make the rest indented code, so the line opens nothing and the table converts.
    const converted = convertMarkdownTables(`> note:\n>     \`\`\`\n>\n> end.\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
  });

  it("reads four spaces before a quote marker as the indented code they already are", () => {
    // The four spaces settle the line before the marker is reached, so the marker is content
    // and opens nothing, which leaves the generated table fences the only ones to balance.
    const converted = convertMarkdownTables(`    > \`\`\`\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
  });

  it("reads a quoted marker at three columns of content as the opener it is", () => {
    // Four spaces, one of them the marker's own, leave three, which still opens a block.
    const converted = convertMarkdownTables(`> note:\n>    \`\`\`\n>\n> end.\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(false);
  });

  it("measures a closer's indentation the way an opener's is measured", () => {
    // Four spaces make the rest of a line indented code wherever the block it sits in
    // begins, so the marker inside the top-level fence is content and the fence closes on
    // the last line rather than the indented one. The item's closer carries the four
    // spaces its content starts at, which is no indentation of its own, so it still
    // closes the fence its marker line opened.
    const authored = [
      "  - ```",
      "    sample",
      "    ```",
      "",
      "```",
      "sample",
      "    ```",
      "```",
    ].join("\n");
    const converted = convertMarkdownTables(`${authored}\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
  });
});

describe("chunkFeishuPostMarkdown", () => {
  it("reserves the first chunk byte budget for native mentions and multibyte text", () => {
    const mentions = [
      {
        openId: "ou_target",
        name: "界".repeat(1_000),
        key: "@_user_1",
      },
    ];
    const chunks = chunkFeishuPostMarkdown({
      text: "界".repeat(11_000),
      limit: 25_000,
      firstChunkMentions: mentions,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      const content = buildFeishuPostMessageContent({
        messageText: chunk,
        mentions: index === 0 ? mentions : undefined,
      });
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30 * 1024);
    }
  });
});
