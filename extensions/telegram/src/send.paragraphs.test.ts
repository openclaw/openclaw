import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi } = getTelegramSendTestMocks();
const { sendMessageTelegram } = await importTelegramSendModule();

describe("Telegram paragraph delivery", () => {
  it("preserves indented code through the shared payload path in newline mode", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 53, chat: { id: "123" } });
    const first = "A".repeat(128);
    const second = "B".repeat(128);
    await sendTextMediaPayload({
      channel: "telegram",
      ctx: {
        cfg: {
          channels: {
            telegram: {
              botToken: "123456:paragraph-regression",
              richMessages: false,
              textChunkLimit: 512,
              streaming: { chunkMode: "length" },
            },
          },
        },
        to: "123",
        text: "",
        payload: { text: `    ${first}\n\n    ${second}` },
        formatting: { textLimit: 256, chunkMode: "newline" },
        deps: { sendTelegram: sendMessageTelegram },
      },
      adapter: telegramOutbound,
    });

    const chunks = botApi.sendMessage.mock.calls.map((call) => String(call[1] ?? ""));
    const code = chunks.map((html) => {
      expect(html.length).toBeLessThanOrEqual(256);
      expect(html).toMatch(/^<pre><code>[\s\S]+<\/code><\/pre>$/u);
      return html.slice("<pre><code>".length, -"</code></pre>".length);
    });
    expect(code.join("")).toBe(`${first}\n\n${second}\n`);
  });
});
