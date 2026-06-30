// Msteams tests cover message handlerm media plugin behavior.
import { describe, expect, it } from "vitest";
import {
  sliceUtf16Safe,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/text-utility-runtime";
import { translateMSTeamsDmConversationIdForGraph } from "../inbound.js";

describe("translateMSTeamsDmConversationIdForGraph", () => {
  it("translates a: conversation ID to Graph format for DMs", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "a:1abc2def3",
      aadObjectId: "user-aad-id",
      appId: "bot-app-id",
    });
    expect(result).toBe("19:user-aad-id_bot-app-id@unq.gbl.spaces");
  });

  it("passes through non-a: conversation IDs unchanged", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "19:existing@unq.gbl.spaces",
      aadObjectId: "user-aad-id",
      appId: "bot-app-id",
    });
    expect(result).toBe("19:existing@unq.gbl.spaces");
  });

  it("passes through when aadObjectId is missing", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "a:1abc2def3",
      aadObjectId: null,
      appId: "bot-app-id",
    });
    expect(result).toBe("a:1abc2def3");
  });

  it("passes through when appId is missing", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: true,
      conversationId: "a:1abc2def3",
      aadObjectId: "user-aad-id",
      appId: null,
    });
    expect(result).toBe("a:1abc2def3");
  });

  it("passes through for non-DM conversations even with a: prefix", () => {
    const result = translateMSTeamsDmConversationIdForGraph({
      isDirectMessage: false,
      conversationId: "a:1abc2def3",
      aadObjectId: "user-aad-id",
      appId: "bot-app-id",
    });
    expect(result).toBe("a:1abc2def3");
  });
});

// Verifies the three rawText / text / preview sites in message-handler.ts
// (lines 250, 251, 505) drop a surrogate pair that straddles the truncation
// boundary instead of leaving a lone high-surrogate half in the preview.
describe("message-handler preview UTF-16 truncation", () => {
  const emoji = "🎉";

  it("truncateUtf16Safe drops a surrogate pair straddling the 50-char boundary (rawText path)", () => {
    const input = "a".repeat(49) + emoji;
    const out = truncateUtf16Safe(input, 50);
    expect(out.length).toBe(49);
    expect(out).toBe("a".repeat(49));
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });

  it("truncateUtf16Safe is a pass-through for plain ASCII (text path)", () => {
    const input = "hello world";
    expect(truncateUtf16Safe(input, 50)).toBe(input);
  });

  it("sliceUtf16Safe preserves an emoji that sits entirely before the 160-char cut (preview path)", () => {
    const input = emoji + "a".repeat(160);
    const out = sliceUtf16Safe(input, 0, 160);
    expect(out.startsWith(emoji)).toBe(true);
    expect(out.length).toBe(160);
  });

  it("sliceUtf16Safe drops a trailing surrogate straddling the 160-char cut (preview path)", () => {
    const input = "a".repeat(159) + emoji;
    const out = sliceUtf16Safe(input, 0, 160);
    expect(out.length).toBe(159);
    expect(out.charCodeAt(out.length - 1)).toBeLessThan(0xd800);
  });
});
