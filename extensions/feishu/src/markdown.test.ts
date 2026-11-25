import { describe, expect, it } from "vitest";
import {
  buildFeishuPostMessageContent,
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
