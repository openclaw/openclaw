import { describe, expect, it } from "vitest";
import {
  extractMSTeamsQuoteInfo,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";

describe("msteams inbound", () => {
  it("removes <at ...> tags with attributes", () => {
    expect(stripMSTeamsMentionTags('<at id="1">Bot</at> hi')).toBe("hi");
    expect(stripMSTeamsMentionTags('hi <at itemid="2">Bot</at>')).toBe("hi");
  });

  describe("parseMSTeamsActivityTimestamp", () => {
    const timestamp = "2024-01-01T00:00:00.000Z";
    it("returns undefined for empty/invalid values", () => {
      expect(parseMSTeamsActivityTimestamp(undefined)).toBeUndefined();
      expect(parseMSTeamsActivityTimestamp("not-a-date")).toBeUndefined();
    });

    it("parses string timestamps", () => {
      expect(parseMSTeamsActivityTimestamp(timestamp)?.toISOString()).toBe(timestamp);
    });

    it("passes through Date instances", () => {
      const d = new Date(timestamp);
      expect(parseMSTeamsActivityTimestamp(d)).toBe(d);
    });
  });

  it("returns true when a mention entity matches recipient.id", () => {
    expect(
      wasMSTeamsBotMentioned({
        recipient: { id: "bot" },
        entities: [{ type: "mention", mentioned: { id: "bot" } }],
      }),
    ).toBe(true);
  });

  describe("extractMSTeamsQuoteInfo", () => {
    const quote = (body: string) =>
      `<blockquote itemtype="http://schema.skype.com/Reply" itemscope>${body}</blockquote>`;
    const sender = (name: string) => `<strong itemprop="mri">${name}</strong>`;
    const copy = (text: string) => `<p itemprop="copy">${text}</p>`;
    const attachment = (content: unknown) => ({ contentType: "text/html", content });

    it("uses 'unknown' as sender when sender element is absent", () => {
      const result = extractMSTeamsQuoteInfo([attachment(quote(copy("quoted text")))]);
      expect(result).toEqual({ sender: "unknown", body: "quoted text" });
    });

    it("returns undefined when body element is absent", () => {
      const result = extractMSTeamsQuoteInfo([attachment(quote(sender("Alice")))]);
      expect(result).toBeUndefined();
    });

    it("skips non-string content values", () => {
      expect(
        extractMSTeamsQuoteInfo([{ contentType: "application/json", content: { foo: "bar" } }]),
      ).toBeUndefined();
    });

    it("handles object content with .text property containing the reply HTML", () => {
      const htmlContent = quote(
        sender("Dave") +
          '<p itemprop="preview">short preview</p>' +
          copy("hello &amp; goodbye\nfrom object"),
      );
      const result = extractMSTeamsQuoteInfo([attachment({ text: htmlContent })]);
      expect(result).toEqual({ sender: "Dave", body: "hello & goodbye from object" });
    });

    it("handles object content with .body property containing the reply HTML", () => {
      const htmlContent = quote(sender("Eve") + copy("hello from body field"));
      const result = extractMSTeamsQuoteInfo([attachment({ body: htmlContent })]);
      expect(result).toEqual({ sender: "Eve", body: "hello from body field" });
    });

    it("finds quote in second attachment when first has no quote", () => {
      const result = extractMSTeamsQuoteInfo([
        { contentType: "text/plain", content: "plain text" },
        attachment(quote(sender("Alice") + copy("Hello world"))),
      ]);
      expect(result).toEqual({ sender: "Alice", body: "Hello world" });
    });

    it("parses a real Teams quote-reply payload (preview + itemid)", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          contentType: "text/html",
          content:
            '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1783379480258">' +
            '<strong itemprop="mri" itemid="28:abc">Display Name</strong>' +
            '<span itemprop="time" itemid="1783379480258"></span>' +
            '<p itemprop="preview">San Francisco right now ... Today\'s range: 54-64 °F (avg…</p>' +
            "</blockquote>\n<p>what abt not?</p>",
        },
      ]);
      expect(result).toEqual({
        sender: "Display Name",
        body: "San Francisco right now ... Today's range: 54-64 °F (avg…",
        id: "1783379480258",
      });
    });
  });
});
