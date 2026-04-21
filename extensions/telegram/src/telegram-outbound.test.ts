import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "../api.js";
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

  it("treats bare group aliases as the same reply-suppression route", () => {
    expect(
      telegramPlugin.outbound?.targetsMatchForReplySuppression?.({
        originTarget: "group:-1001234567890:topic:456",
        targetKey: "telegram:group:-1001234567890:topic:456",
      }),
    ).toBe(true);
  });
});
