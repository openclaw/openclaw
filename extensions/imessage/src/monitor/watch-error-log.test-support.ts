// Imessage test support covers watch error log plugin behavior.
import { describe, expect, it } from "vitest";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

describe("sanitizeIMessageWatchErrorPayload", () => {
  it("keeps the failure code without copying private watch error content", () => {
    expect(
      sanitizeIMessageWatchErrorPayload({
        code: 500,
        message: "private-watch-error-content",
        chatId: "chat-123",
        participants: ["+15555550123"],
        path: "/Users/me/Library/Messages/chat.db",
      }),
    ).toEqual({
      code: 500,
    });
  });

  it("drops non-object payloads and unsupported fields", () => {
    expect(sanitizeIMessageWatchErrorPayload("boom")).toStrictEqual({});
    expect(
      sanitizeIMessageWatchErrorPayload({
        code: Number.POSITIVE_INFINITY,
        message: 123,
        data: { sender: "+15555550123" },
      }),
    ).toStrictEqual({});
  });
});
