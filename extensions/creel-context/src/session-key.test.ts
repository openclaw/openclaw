import { describe, expect, it } from "vitest";
import { deriveSessionKeyForInbound, isGroupConversationId } from "./session-key.js";

describe("deriveSessionKeyForInbound", () => {
  it("collapses non-group DMs into the canonical agent:main:main bucket", () => {
    expect(deriveSessionKeyForInbound("whatsapp", "+15551234@s.whatsapp.net")).toEqual({
      sessionKey: "agent:main:main",
    });
    expect(deriveSessionKeyForInbound("telegram", "12345")).toEqual({
      sessionKey: "agent:main:main",
    });
  });

  it("returns a group-shaped key + groupKey for group conversations", () => {
    expect(deriveSessionKeyForInbound("whatsapp", "1234567890-1234567890@g.us")).toEqual({
      sessionKey: "agent:main:whatsapp:group:1234567890-1234567890@g.us",
      groupKey: "1234567890-1234567890@g.us",
    });
    expect(deriveSessionKeyForInbound("telegram", "-1001234567890")).toEqual({
      sessionKey: "agent:main:telegram:group:-1001234567890",
      groupKey: "-1001234567890",
    });
  });

  it("falls back to DM bucket when conversationId is missing", () => {
    expect(deriveSessionKeyForInbound("whatsapp", undefined)).toEqual({
      sessionKey: "agent:main:main",
    });
  });
});

describe("isGroupConversationId", () => {
  it("flags WhatsApp groups by @g.us suffix", () => {
    expect(isGroupConversationId("whatsapp", "12-34@g.us")).toBe(true);
    expect(isGroupConversationId("whatsapp", "12@s.whatsapp.net")).toBe(false);
    expect(isGroupConversationId("whatsapp", "12@c.us")).toBe(false);
  });

  it("flags Telegram groups by leading minus (chat_id<0 convention)", () => {
    expect(isGroupConversationId("telegram", "-12345")).toBe(true);
    expect(isGroupConversationId("telegram", "-1001234567890")).toBe(true);
    expect(isGroupConversationId("telegram", "12345")).toBe(false);
  });

  it("flags Slack non-DM channels by prefix", () => {
    expect(isGroupConversationId("slack", "C12345")).toBe(true); // public
    expect(isGroupConversationId("slack", "G12345")).toBe(true); // legacy private
    expect(isGroupConversationId("slack", "MPDM-abc")).toBe(true); // multi-party DM
    expect(isGroupConversationId("slack", "D12345")).toBe(false); // DM
  });

  it("conservatively treats unknown / signal-poor channels as DM", () => {
    for (const ch of ["discord", "matrix", "imessage", "icloud", "signal", "webchat", "unknown"]) {
      expect(isGroupConversationId(ch, "anything")).toBe(false);
    }
  });

  it("returns false for missing conversationId regardless of channel", () => {
    expect(isGroupConversationId("whatsapp", undefined)).toBe(false);
    expect(isGroupConversationId("telegram", undefined)).toBe(false);
    expect(isGroupConversationId("slack", undefined)).toBe(false);
  });
});
