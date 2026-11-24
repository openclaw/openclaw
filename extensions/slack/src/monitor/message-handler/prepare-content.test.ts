import type { RichTextElement } from "@slack/types";
import { describe, expect, it } from "vitest";
import { resolveSlackMessageContent } from "./prepare-content.js";

function resolveRichTextContent(elements: RichTextElement[]) {
  return resolveSlackMessageContent({
    message: {
      type: "message",
      channel: "D123",
      blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements }] }],
    },
    isThreadReply: false,
    threadStarter: null,
    isBotMessage: false,
    botToken: "xoxb-test",
    mediaMaxBytes: 1024,
  });
}

describe("Slack rich-text date content", () => {
  it.each([
    { timestamp: 1_700_000_000, expected: "2023-11-14T22:13:20.000Z" },
    { timestamp: 0, expected: "1970-01-01T00:00:00.000Z" },
  ])("keeps a date-only message at timestamp $timestamp", async ({ timestamp, expected }) => {
    const result = await resolveRichTextContent([
      { type: "date", timestamp, format: "{date_long} at {time}" },
    ]);

    expect(result).toEqual({
      rawBody: expected,
      effectiveDirectMedia: null,
      commandSourceText: "",
      mentionStripPatterns: [],
    });
  });

  it.each([
    { fallback: undefined, expected: "Meet on 2023-11-14T22:13:20.000Z after lunch." },
    { fallback: "Nov 14", expected: "Meet on Nov 14 after lunch." },
  ])(
    "keeps dates and surrounding spaces with fallback $fallback",
    async ({ fallback, expected }) => {
      const result = await resolveRichTextContent([
        { type: "text", text: "Meet on " },
        { type: "date", timestamp: 1_700_000_000, format: "{date_short}", fallback },
        { type: "text", text: " after lunch." },
      ]);

      expect(result?.rawBody).toBe(expected);
    },
  );

  it.each([0, Number.NaN])("prefers the supplied fallback for timestamp %s", async (timestamp) => {
    const result = await resolveRichTextContent([
      { type: "date", timestamp, format: "{date_short}", fallback: "<tomorrow> & later" },
    ]);

    expect(result?.rawBody).toBe("&lt;tomorrow&gt; &amp; later");
  });

  it.each([undefined, null, "1700000000", Number.NaN, Number.POSITIVE_INFINITY, 1e20])(
    "ignores an invalid date timestamp %s without losing other text",
    async (timestamp) => {
      const date: RichTextElement = { type: "date", timestamp: 0, format: "{date_short}" };
      // Deliberately violate the SDK type to exercise malformed runtime payloads.
      Reflect.set(date, "timestamp", timestamp);
      const result = await resolveRichTextContent([
        { type: "text", text: "Before " },
        date,
        { type: "text", text: "after" },
      ]);

      expect(result?.rawBody).toBe("Before after");
    },
  );
});
