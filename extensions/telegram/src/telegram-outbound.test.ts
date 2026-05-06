import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import { telegramOutboundBaseAdapter } from "./outbound-base.js";
import { clearTelegramRuntime } from "./runtime.js";

describe("telegramPlugin outbound", () => {
  it("uses static chunking when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = chunkMarkdownText(text, 4000);

    expect(telegramOutboundBaseAdapter.chunker(text, 4000)).toEqual(expected);
    expect(telegramOutboundBaseAdapter.deliveryMode).toBe("direct");
    expect(telegramOutboundBaseAdapter.chunkerMode).toBe("markdown");
    expect(telegramOutboundBaseAdapter.textChunkLimit).toBe(4000);
  });

  it("marks registered text sends as provider accepted", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValue({ messageId: "tg-registered-text", chatId: "12345" });

    const result = await telegramPlugin.outbound!.sendText!({
      cfg: {} as never,
      to: "12345",
      text: "registered text",
      deps: { telegram: sendTelegram },
    });

    expect(result).toEqual({
      channel: "telegram",
      messageId: "tg-registered-text",
      chatId: "12345",
      delivery: { providerAccepted: true },
    });
  });

  it("marks registered media sends as provider accepted", async () => {
    const sendTelegram = vi
      .fn()
      .mockResolvedValue({ messageId: "tg-registered-media", chatId: "12345" });

    const result = await telegramPlugin.outbound!.sendMedia!({
      cfg: {} as never,
      to: "12345",
      text: "registered media",
      mediaUrl: "/tmp/image.png",
      deps: { telegram: sendTelegram },
    });

    expect(result).toEqual({
      channel: "telegram",
      messageId: "tg-registered-media",
      chatId: "12345",
      delivery: { providerAccepted: true },
    });
  });
});
