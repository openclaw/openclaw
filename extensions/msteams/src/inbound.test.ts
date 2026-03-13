import { describe, expect, it } from "vitest";
import {
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "./inbound.js";

describe("msteams inbound", () => {
  describe("stripMSTeamsMentionTags", () => {
    it("removes <at>...</at> tags and trims", () => {
      expect(stripMSTeamsMentionTags("<at>Bot</at> hi")).toBe("hi");
      expect(stripMSTeamsMentionTags("hi <at>Bot</at>")).toBe("hi");
    });

    it("removes <at ...> tags with attributes", () => {
      expect(stripMSTeamsMentionTags('<at id="1">Bot</at> hi')).toBe("hi");
      expect(stripMSTeamsMentionTags('hi <at itemid="2">Bot</at>')).toBe("hi");
    });
  });

  describe("normalizeMSTeamsConversationId", () => {
    it("strips the ;messageid suffix", () => {
      expect(normalizeMSTeamsConversationId("19:abc@thread.tacv2;messageid=deadbeef")).toBe(
        "19:abc@thread.tacv2",
      );
    });
  });

  describe("parseMSTeamsActivityTimestamp", () => {
    it("returns undefined for empty/invalid values", () => {
      expect(parseMSTeamsActivityTimestamp(undefined)).toBeUndefined();
      expect(parseMSTeamsActivityTimestamp("not-a-date")).toBeUndefined();
    });

    it("parses string timestamps", () => {
      const ts = parseMSTeamsActivityTimestamp("2024-01-01T00:00:00.000Z");
      expect(ts?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
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
});

import { extractMSTeamsQuoteInfo, type MSTeamsQuoteInfo } from "./inbound.js";

describe("extractMSTeamsQuoteInfo", () => {
  it("returns undefined when there are no attachments", () => {
    expect(extractMSTeamsQuoteInfo({ text: "hello" })).toBeUndefined();
  });

  it("returns undefined when attachments have no text/html type", () => {
    expect(
      extractMSTeamsQuoteInfo({
        text: "hello",
        attachments: [{ contentType: "image/png" }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when html attachment has no blockquote", () => {
    expect(
      extractMSTeamsQuoteInfo({
        text: "hello",
        attachments: [{ contentType: "text/html", content: "<p>just text</p>" }],
      }),
    ).toBeUndefined();
  });

  it("extracts quote from Teams schema.skype.com/Reply blockquote", () => {
    const html = [
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1234">',
      '  <strong itemprop="mri" itemid="user:abc">Jianmei Yu</strong>',
      '  <span itemprop="time" itemid="2026-03-13T05:57:00Z"></span>',
      '  <p itemprop="copy">是你偷偷改格式了吗？</p>',
      "</blockquote>",
      "<p>不是我改的</p>",
    ].join("\n");

    const result = extractMSTeamsQuoteInfo({
      text: "Jianmei Yu是你偷偷改格式了吗？不是我改的",
      attachments: [{ contentType: "text/html", content: html }],
    });

    expect(result).toBeDefined();
    expect(result!.quotedSender).toBe("Jianmei Yu");
    expect(result!.quotedBody).toBe("是你偷偷改格式了吗？");
    expect(result!.cleanBody).toBe("不是我改的");
  });

  it("ignores generic blockquote without schema.skype.com/Reply attrs", () => {
    const html = [
      "<blockquote>",
      "  <strong>Robin Liu</strong>",
      "  <p>original message</p>",
      "</blockquote>",
      "<p>my reply here</p>",
    ].join("\n");

    const result = extractMSTeamsQuoteInfo({
      text: "Robin Liuoriginal messagemy reply here",
      attachments: [{ contentType: "text/html", content: html }],
    });

    // Generic blockquotes should not be treated as reply metadata
    expect(result).toBeUndefined();
  });

  it("handles content as object with text property", () => {
    const html =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="msg1">' +
      "<strong>Alice</strong>" +
      '<p itemprop="copy">hello world</p>' +
      "</blockquote>" +
      "<p>hi Alice</p>";

    const result = extractMSTeamsQuoteInfo({
      text: "Alicehello worldhi Alice",
      attachments: [{ contentType: "text/html", content: { text: html } }],
    });

    expect(result).toBeDefined();
    expect(result!.quotedSender).toBe("Alice");
    expect(result!.quotedBody).toBe("hello world");
    expect(result!.cleanBody).toBe("hi Alice");
  });

  it("falls back to text param when afterBlockquote is empty", () => {
    const html =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="x">' +
      "<strong>Bob</strong>" +
      '<p itemprop="copy">some quote</p>' +
      "</blockquote>";

    const result = extractMSTeamsQuoteInfo({
      text: "Bobsome quotemy actual message",
      attachments: [{ contentType: "text/html", content: html }],
    });

    expect(result).toBeDefined();
    expect(result!.quotedSender).toBe("Bob");
    expect(result!.quotedBody).toBe("some quote");
    // When no content after blockquote, falls back to full text
    expect(result!.cleanBody).toBe("Bobsome quotemy actual message");
  });

  it("handles mentions inside blockquote sender", () => {
    const html =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">' +
      '<strong itemprop="mri">Xiang <span>Chen</span></strong>' +
      '<p itemprop="copy">谢谢</p>' +
      "</blockquote>" +
      "不客气";

    const result = extractMSTeamsQuoteInfo({
      text: "Xiang Chen谢谢不客气",
      attachments: [{ contentType: "text/html", content: html }],
    });

    expect(result).toBeDefined();
    expect(result!.quotedSender).toBe("Xiang Chen");
    expect(result!.quotedBody).toBe("谢谢");
    expect(result!.cleanBody).toBe("不客气");
  });

  it("decodes numeric HTML entities in quoted content", () => {
    const html =
      '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1">' +
      "<strong>Alice</strong>" +
      '<p itemprop="copy">Hello &#x2019;world&#x2019; &#8212; test</p>' +
      "</blockquote>" +
      "<p>reply here</p>";

    const result = extractMSTeamsQuoteInfo({
      text: "Alicereply here",
      attachments: [{ contentType: "text/html", content: html }],
    });

    expect(result).toBeDefined();
    expect(result!.quotedBody).toBe("Hello \u2019world\u2019 \u2014 test");
    expect(result!.cleanBody).toBe("reply here");
  });
});
