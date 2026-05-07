import { describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { telegramOutbound } from "./outbound-adapter.js";
import { clearTelegramRuntime } from "./runtime.js";

describe("telegramPlugin outbound", () => {
  it("uses static outbound contract when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = markdownToTelegramHtmlChunks(text, 4000);

    expect(telegramOutbound.chunker?.(text, 4000)).toEqual(expected);
    expect(telegramOutbound.deliveryMode).toBe("direct");
    expect(telegramOutbound.chunkerMode).toBe("markdown");
    expect(telegramOutbound.textChunkLimit).toBe(4000);
    expect(telegramOutbound.pollMaxOptions).toBe(10);
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
