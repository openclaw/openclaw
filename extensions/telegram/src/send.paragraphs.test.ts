import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram paragraph delivery", () => {
  const fixture = useTelegramHttpFixture();

  it("preserves indented code through the shared payload path in newline mode", async () => {
    const first = "A".repeat(128);
    const second = "B".repeat(128);
    await sendTextMediaPayload({
      channel: "telegram",
      ctx: {
        cfg: {
          channels: {
            telegram: {
              ...fixture.cfg.channels.telegram,
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

    const chunks = fixture.requests
      .filter(({ method }) => method === "sendMessage")
      .map(({ fields }) => {
        expect(fields.parse_mode).toBe("HTML");
        if (typeof fields.text !== "string") {
          throw new Error("Expected a string Telegram sendMessage text");
        }
        return fields.text;
      });
    const code = chunks.map((html) => {
      expect(html.length).toBeLessThanOrEqual(256);
      expect(html).toMatch(/^<pre><code>[\s\S]+<\/code><\/pre>$/u);
      return html.slice("<pre><code>".length, -"</code></pre>".length);
    });
    expect(code.join("")).toBe(`${first}\n\n${second}\n`);
  });
});
