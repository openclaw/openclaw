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

  it("includes replyToId from inReplyTo", () => {
    const ctx = mapEmailToInbound(makeEmail({ inReplyTo: "<parent@example.com>" }));
    expect(ctx.replyToId).toBe("<parent@example.com>");
  });
});

describe("buildInboundMsgFields", () => {
  it("builds SDK-compatible fields", () => {
    const fields = buildInboundMsgFields(makeEmail(), "default");
    expect(fields.From).toBe("inboxapi:alice@example.com");
    expect(fields.OriginatingChannel).toBe("inboxapi");
    expect(fields.AccountId).toBe("default");
    expect(fields.ChatType).toBe("direct");
    expect(fields.ConversationLabel).toBe("Test Subject");
    expect(fields.SenderName).toBe("Alice");
    expect(fields.CommandAuthorized).toBe(true);
  });
});
