import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { clearTelegramRuntime } from "./runtime.js";

describe("telegramPlugin outbound", () => {
  it("uses static chunking when Telegram runtime is uninitialized", () => {
    clearTelegramRuntime();
    const text = `${"hello\n".repeat(1200)}tail`;
    const expected = chunkMarkdownText(text, 4000);

    expect(telegramPlugin.outbound?.chunker?.(text, 4000)).toEqual(expected);
  });
});
