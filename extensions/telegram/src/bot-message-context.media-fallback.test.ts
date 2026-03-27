import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

describe("buildTelegramMessageContext document fallback messaging", () => {
  it("renders the placeholder with the Telegram document fallback reason", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        date: 1700000000,
        text: undefined,
        from: { id: 42, first_name: "Alice" },
        document: { file_id: "doc-1", file_unique_id: "doc-u1" },
      },
      options: {
        mediaUnavailableText: "Telegram attachment unavailable: file too large for Bot API download",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.BodyForAgent).toBe(
      "<media:document>\nTelegram attachment unavailable: file too large for Bot API download",
    );
    expect(ctx?.ctxPayload?.Body).toContain("<media:document>");
    expect(ctx?.ctxPayload?.Body).toContain(
      "Telegram attachment unavailable: file too large for Bot API download",
    );
  });

  it("keeps user text, document placeholder, and fallback reason in order", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 2,
        chat: { id: 1234, type: "private" },
        date: 1700000001,
        text: "please review this",
        from: { id: 42, first_name: "Alice" },
        document: { file_id: "doc-2", file_unique_id: "doc-u2" },
      },
      options: {
        mediaUnavailableText: "Telegram attachment unavailable: download failed",
      },
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.BodyForAgent).toBe(
      [
        "please review this",
        "<media:document>",
        "Telegram attachment unavailable: download failed",
      ].join("\n"),
    );
  });
});
