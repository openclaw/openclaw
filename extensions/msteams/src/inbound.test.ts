// Msteams tests cover inbound plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildMSTeamsNormalizedText,
  extractMSTeamsQuoteInfo,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";

describe("msteams inbound", () => {
  describe("buildMSTeamsNormalizedText", () => {
    it("normalizes user mentions while removing the bot mention", () => {
      expect(
        buildMSTeamsNormalizedText({
          text: "<at>Bot</at> ask <at>Alice</at>",
          botId: "bot-id",
          entities: [
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
            {
              type: "mention",
              text: "<at>Alice</at>",
              mentioned: { id: "alice-id", name: "Alice" },
            },
          ],
        }),
      ).toBe("ask @Alice");
    });

    it("matches reordered mention entities to their text spans", () => {
      expect(
        buildMSTeamsNormalizedText({
          text: "<at>Bot</at> ask <at>Alice</at>",
          botId: "bot-id",
          entities: [
            {
              type: "mention",
              text: "<at>Alice</at>",
              mentioned: { id: "alice-id", name: "Alice" },
            },
            { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
          ],
        }),
      ).toBe("ask @Alice");
    });

    it("removes every inline quote marker", () => {
      expect(
        buildMSTeamsNormalizedText({
          text: '<quoted messageId="one"/>\n<quoted messageId="two"/>\ncurrent message',
        }),
      ).toBe("current message");
    });

    it("labels forwarded body text", () => {
      expect(
        buildMSTeamsNormalizedText({
          text: "see this\r\n\r\nthe forwarded body",
          attachments: [
            {
              contentType: "text/html",
              content:
                '<blockquote itemtype="http://schema.skype.com/Forward"><p>the forwarded body</p></blockquote>',
            },
          ],
        }),
      ).toBe("see this\n\n[Forwarded message]\nthe forwarded body\n[/Forwarded message]");
    });
  });

  describe("stripMSTeamsMentionTags", () => {
    it("removes <at ...> tags with attributes", () => {
      expect(stripMSTeamsMentionTags('<at id="1">Bot</at> hi')).toBe("hi");
      expect(stripMSTeamsMentionTags('hi <at itemid="2">Bot</at>')).toBe("hi");
    });
  });

  describe("parseMSTeamsActivityTimestamp", () => {
    it("returns undefined for empty/invalid values", () => {
      expect(parseMSTeamsActivityTimestamp(undefined)).toBeUndefined();
      expect(parseMSTeamsActivityTimestamp("not-a-date")).toBeUndefined();
    });

    it("parses string timestamps", () => {
      const ts = parseMSTeamsActivityTimestamp("2024-01-01T00:00:00.000Z");
      if (!ts) {
        throw new Error("expected MSTeams timestamp parser to return a Date");
      }
      expect(ts.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    });

    it("passes through Date instances", () => {
      const d = new Date("2024-01-01T00:00:00.000Z");
      expect(parseMSTeamsActivityTimestamp(d)).toBe(d);
    });
  });

  describe("wasMSTeamsBotMentioned", () => {
    it("returns true when a mention entity matches recipient.id", () => {
      expect(
        wasMSTeamsBotMentioned({
          recipient: { id: "bot" },
          entities: [{ type: "mention", mentioned: { id: "bot" } }],
        }),
      ).toBe(true);
    });

    it("returns false when there is no matching mention", () => {
      expect(
        wasMSTeamsBotMentioned({
          recipient: { id: "bot" },
          entities: [{ type: "mention", mentioned: { id: "other" } }],
        }),
      ).toBe(false);
    });
  });

  describe("extractMSTeamsQuoteInfo", () => {
    const replyAttachment = (overrides?: { content?: string; contentType?: string }) => ({
      contentType: overrides?.contentType ?? "text/html",
      content:
        overrides?.content ??
        '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
          '<strong itemprop="mri">Alice</strong>' +
          '<p itemprop="copy">Hello world</p>' +
          "</blockquote>",
    });

    it("returns undefined for empty attachments array", () => {
      expect(extractMSTeamsQuoteInfo([])).toBeUndefined();
    });

    it("prefers authenticated quotedReply metadata over attachment HTML", () => {
      expect(
        extractMSTeamsQuoteInfo(
          [replyAttachment()],
          [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "quote-1",
                senderId: "blocked-aad",
                senderName: "Mallory",
                preview: "entity preview",
              },
            },
          ],
        ),
      ).toEqual({
        id: "quote-1",
        senderId: "blocked-aad",
        sender: "Mallory",
        body: "entity preview",
        fromQuotedReplyEntity: true,
      });
    });

    it("keeps entity sender identity when its message id matches the attachment", () => {
      expect(
        extractMSTeamsQuoteInfo(
          [
            replyAttachment({
              content:
                '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-1">' +
                '<strong itemprop="mri">Mallory</strong>' +
                '<p itemprop="copy">Hello world</p></blockquote>',
            }),
          ],
          [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "quote-1",
                senderId: "blocked-aad",
                senderName: "Mallory",
              },
            },
          ],
        ),
      ).toEqual({
        senderId: "blocked-aad",
        sender: "Mallory",
        body: "Hello world",
        id: "quote-1",
        fromQuotedReplyEntity: true,
      });
    });

    it("rejects an attachment body whose message id does not match the entity", () => {
      expect(
        extractMSTeamsQuoteInfo(
          [
            replyAttachment({
              content:
                '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-b">' +
                '<strong itemprop="mri">Mallory</strong>' +
                '<p itemprop="copy">Blocked attachment body</p></blockquote>',
            }),
          ],
          [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "quote-a",
                senderId: "alice-aad",
                senderName: "Alice",
              },
            },
          ],
        ),
      ).toBeUndefined();
    });

    it("does not combine one Reply block's id with another block's body", () => {
      expect(
        extractMSTeamsQuoteInfo(
          [
            replyAttachment({
              content:
                '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-a">' +
                '<strong itemprop="mri">Alice</strong></blockquote>' +
                '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-b">' +
                '<strong itemprop="mri">Mallory</strong>' +
                '<p itemprop="copy">Blocked attachment body</p></blockquote>',
            }),
          ],
          [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "quote-a",
                senderId: "alice-aad",
                senderName: "Alice",
              },
            },
          ],
        ),
      ).toBeUndefined();
    });

    it("returns undefined when no reply blockquote is present", () => {
      expect(
        extractMSTeamsQuoteInfo([{ contentType: "text/html", content: "<p>just a message</p>" }]),
      ).toBeUndefined();
    });

    it("uses 'unknown' as sender when sender element is absent", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          contentType: "text/html",
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<p itemprop="copy">quoted text</p>' +
            "</blockquote>",
        },
      ]);
      expect(result).toEqual({ sender: "unknown", body: "quoted text" });
    });

    it("returns undefined when body element is absent", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          contentType: "text/html",
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Alice</strong>' +
            "</blockquote>",
        },
      ]);
      expect(result).toBeUndefined();
    });

    it("decodes HTML entities in body text", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          contentType: "text/html",
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Bob</strong>' +
            '<p itemprop="copy">2 &lt; 3 &amp; 4 &gt; 1; &copy;&Tab;keep &amp;lt; literal</p>' +
            "</blockquote>",
        },
      ]);
      expect(result).toEqual({ sender: "Bob", body: "2 < 3 & 4 > 1; © keep &lt; literal" });
    });

    it("handles multiline body by collapsing whitespace", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          contentType: "text/html",
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Carol</strong>' +
            '<p itemprop="copy">line one\nline two</p>' +
            "</blockquote>",
        },
      ]);
      expect(result?.body).toBe("line one line two");
    });

    it("skips non-string content values", () => {
      expect(
        extractMSTeamsQuoteInfo([{ contentType: "application/json", content: { foo: "bar" } }]),
      ).toBeUndefined();
    });

    it("handles object content with .text property containing the reply HTML", () => {
      const htmlContent =
        '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
        '<strong itemprop="mri">Dave</strong>' +
        '<p itemprop="copy">hello from object</p>' +
        "</blockquote>";
      const result = extractMSTeamsQuoteInfo([
        { contentType: "text/html", content: { text: htmlContent } },
      ]);
      expect(result).toEqual({ sender: "Dave", body: "hello from object" });
    });

    it("handles object content with .body property containing the reply HTML", () => {
      const htmlContent =
        '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
        '<strong itemprop="mri">Eve</strong>' +
        '<p itemprop="copy">hello from body field</p>' +
        "</blockquote>";
      const result = extractMSTeamsQuoteInfo([
        { contentType: "text/html", content: { body: htmlContent } },
      ]);
      expect(result).toEqual({ sender: "Eve", body: "hello from body field" });
    });

    it("finds quote in second attachment when first has no quote", () => {
      const result = extractMSTeamsQuoteInfo([
        { contentType: "text/plain", content: "plain text" },
        replyAttachment(),
      ]);
      expect(result).toEqual({ sender: "Alice", body: "Hello world" });
    });

    it("prefers 'copy' over 'preview' when both are present", () => {
      const result = extractMSTeamsQuoteInfo([
        {
          contentType: "text/html",
          content:
            '<blockquote itemtype="http://schema.skype.com/Reply" itemscope>' +
            '<strong itemprop="mri">Grace</strong>' +
            '<p itemprop="preview">short…</p>' +
            '<p itemprop="copy">the full text</p>' +
            "</blockquote>",
        },
      ]);
      expect(result?.body).toBe("the full text");
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
