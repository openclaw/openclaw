import { describe, expect, it } from "vitest";
import type { ZaloMessage } from "./api.js";
import { resolveInboundZaloPhotoUrl } from "./monitor.js";

function createMessage(overrides: Partial<ZaloMessage> = {}): ZaloMessage {
  return {
    message_id: "msg-1",
    from: { id: "user-1" },
    chat: { id: "chat-1", chat_type: "PRIVATE" },
    date: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("resolveInboundZaloPhotoUrl", () => {
  it("prefers the inbound photo_url field from Zalo image events", () => {
    expect(
      resolveInboundZaloPhotoUrl(
        createMessage({
          photo_url: "https://example.com/photo.jpg",
          photo: "https://example.com/legacy.jpg",
        }),
      ),
    ).toBe("https://example.com/photo.jpg");
  });

  it("falls back to the legacy photo field when photo_url is absent", () => {
    expect(
      resolveInboundZaloPhotoUrl(
        createMessage({
          photo: "https://example.com/legacy.jpg",
        }),
      ),
    ).toBe("https://example.com/legacy.jpg");
  });
});
