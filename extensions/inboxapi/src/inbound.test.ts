import { describe, it, expect } from "vitest";
import { mapEmailToInbound, buildInboundMsgFields } from "./inbound.js";
import type { InboxApiEmail } from "./types.js";

function makeEmail(overrides: Partial<InboxApiEmail> = {}): InboxApiEmail {
  return {
    id: "e1",
    messageId: "<msg1@example.com>",
    from: "Alice <alice@example.com>",
    to: "bot@inboxapi.ai",
    subject: "Test Subject",
    text: "Hello from Alice",
    date: "2026-03-09T12:00:00Z",
    ...overrides,
  };
}

describe("mapEmailToInbound", () => {
  it("maps basic email", () => {
    const ctx = mapEmailToInbound(makeEmail());
    expect(ctx.body).toBe("Hello from Alice");
    expect(ctx.from).toBe("alice@example.com");
    expect(ctx.senderName).toBe("Alice");
    expect(ctx.conversationLabel).toBe("Test Subject");
    expect(ctx.currentMessageId).toBe("<msg1@example.com>");
    expect(ctx.chatType).toBe("direct");
  });

  it("falls back to HTML body", () => {
    const ctx = mapEmailToInbound(
      makeEmail({ text: undefined, html: "<p>Hello <b>World</b></p>" }),
    );
    expect(ctx.body).toBe("Hello World");
  });

  it("uses fromName when available", () => {
    const ctx = mapEmailToInbound(makeEmail({ fromName: "Alice Jones" }));
    expect(ctx.senderName).toBe("Alice Jones");
  });

  it("uses email as sender name fallback", () => {
    const ctx = mapEmailToInbound(makeEmail({ from: "alice@example.com" }));
    expect(ctx.senderName).toBe("alice@example.com");
  });

  it("handles no subject", () => {
    const ctx = mapEmailToInbound(makeEmail({ subject: "" }));
    expect(ctx.conversationLabel).toBe("(no subject)");
  });

  it("stores InboxAPI internal ID as replyToInternalId", () => {
    const ctx = mapEmailToInbound(makeEmail({ id: "internal-123" }));
    expect(ctx.replyToInternalId).toBe("internal-123");
  });
});

describe("buildInboundMsgFields", () => {
  it("builds SDK-compatible fields", () => {
    const fields = buildInboundMsgFields(makeEmail(), "default", false);
    expect(fields.From).toBe("inboxapi:alice@example.com");
    expect(fields.To).toBe("inboxapi:bot@inboxapi.ai");
    expect(fields.OriginatingChannel).toBe("inboxapi");
    expect(fields.AccountId).toBe("default");
    expect(fields.ChatType).toBe("direct");
    expect(fields.ConversationLabel).toBe("Test Subject");
    expect(fields.SenderName).toBe("Alice");
    expect(fields.CommandAuthorized).toBe(false);
  });

  it("sets MessageSid and MessageSidFull", () => {
    const fields = buildInboundMsgFields(makeEmail(), "default", false);
    expect(fields.MessageSid).toBe("e1");
    expect(fields.MessageSidFull).toBe("<msg1@example.com>");
  });

  it("sets MessageThreadId from thread root", () => {
    const email = makeEmail({ references: ["<root@example.com>", "<mid@example.com>"] });
    const fields = buildInboundMsgFields(email, "default", false);
    expect(fields.MessageThreadId).toBe("<root@example.com>");
  });

  it("uses InboxAPI internal ID as ReplyToId", () => {
    const fields = buildInboundMsgFields(makeEmail({ id: "internal-456" }), "default", false);
    expect(fields.ReplyToId).toBe("internal-456");
  });

  it("handles invalid date gracefully", () => {
    const fields = buildInboundMsgFields(makeEmail({ date: "invalid" }), "default", false);
    expect(Number.isFinite(fields.Timestamp)).toBe(true);
    expect(fields.Timestamp).toBeGreaterThan(0);
  });

  it("passes commandAuthorized through", () => {
    const fields = buildInboundMsgFields(makeEmail(), "default", true);
    expect(fields.CommandAuthorized).toBe(true);
  });
});
