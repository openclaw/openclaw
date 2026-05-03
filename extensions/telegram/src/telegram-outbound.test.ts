import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { splitTelegramHtmlChunks } from "./format.js";
import { telegramOutboundBaseAdapter } from "./outbound-base.js";
import { clearTelegramRuntime } from "./runtime.js";

describe("telegramPlugin outbound", () => {
  it("uses static chunking when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = chunkMarkdownText(text, 4000);

    expect(telegramOutboundBaseAdapter.chunker(text, 4000)).toEqual(expected);
    expect(telegramOutboundBaseAdapter.deliveryMode).toBe("direct");
    expect(telegramOutboundBaseAdapter.chunkerMode).toBe("text");
    expect(telegramOutboundBaseAdapter.textChunkLimit).toBe(4000);
  });

  it("uses HTML-safe chunking when explicit Telegram parse mode is active", () => {
    clearTelegramRuntime();
    const html = `<b>${"A\n".repeat(2500)}</b>`;

    expect(
      telegramOutboundBaseAdapter.chunker(html, 4000, { formatting: { parseMode: "HTML" } }),
    ).toEqual(splitTelegramHtmlChunks(html, 4000));
  });
});
