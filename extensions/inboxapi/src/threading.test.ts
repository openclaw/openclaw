import { describe, it, expect } from "vitest";
import {
  getThreadRootId,
  deriveSessionKey,
  extractSenderEmail,
  extractSenderName,
} from "./threading.js";
import type { InboxApiEmail } from "./types.js";

function makeEmail(overrides: Partial<InboxApiEmail> = {}): InboxApiEmail {
  return {
    id: "e1",
    messageId: "<msg1@example.com>",
    from: "sender@example.com",
    to: "bot@inboxapi.ai",
    subject: "Test",
    date: "2026-03-09T12:00:00Z",
    ...overrides,
  };
}

describe("getThreadRootId", () => {
  it("uses first entry in References", () => {
    const email = makeEmail({
      references: ["<root@example.com>", "<mid@example.com>"],
      inReplyTo: "<mid@example.com>",
    });
    expect(getThreadRootId(email)).toBe("<root@example.com>");
  });

  it("falls back to In-Reply-To", () => {
    const email = makeEmail({
      inReplyTo: "<parent@example.com>",
    });
    expect(getThreadRootId(email)).toBe("<parent@example.com>");
  });

  it("uses self Message-ID for new threads", () => {
    const email = makeEmail();
    expect(getThreadRootId(email)).toBe("<msg1@example.com>");
  });
});

describe("deriveSessionKey", () => {
  it("produces stable hash-based key", () => {
    const email = makeEmail();
    const key = deriveSessionKey(email);
    expect(key).toMatch(/^inboxapi-[0-9a-f]{16}$/);
    // Same email produces same key
    expect(deriveSessionKey(email)).toBe(key);
  });

  it("same thread root produces same key", () => {
    const e1 = makeEmail({ messageId: "<msg1@x.com>", references: ["<root@x.com>"] });
    const e2 = makeEmail({ messageId: "<msg2@x.com>", references: ["<root@x.com>"] });
    expect(deriveSessionKey(e1)).toBe(deriveSessionKey(e2));
  });

  it("different threads produce different keys", () => {
    const e1 = makeEmail({ messageId: "<a@x.com>" });
    const e2 = makeEmail({ messageId: "<b@x.com>" });
    expect(deriveSessionKey(e1)).not.toBe(deriveSessionKey(e2));
  });
});

describe("extractSenderEmail", () => {
  it("extracts from angle-bracket format", () => {
    expect(extractSenderEmail("Alice <alice@example.com>")).toBe("alice@example.com");
  });

  it("handles plain email", () => {
    expect(extractSenderEmail("bob@example.com")).toBe("bob@example.com");
  });

  it("lowercases", () => {
    expect(extractSenderEmail("BOB@EXAMPLE.COM")).toBe("bob@example.com");
  });
});

describe("extractSenderName", () => {
  it("extracts name from angle-bracket format", () => {
    expect(extractSenderName("Alice Smith <alice@example.com>")).toBe("Alice Smith");
  });

  it("strips quotes", () => {
    expect(extractSenderName('"Alice Smith" <alice@example.com>')).toBe("Alice Smith");
  });

  it("returns empty for plain email", () => {
    expect(extractSenderName("alice@example.com")).toBe("");
  });
});
