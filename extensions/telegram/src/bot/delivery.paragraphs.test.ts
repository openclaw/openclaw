import { describe, expect, it } from "vitest";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { deliverReplies } from "./delivery.js";

describe("Telegram reply paragraph delivery", () => {
  const fixture = useTelegramHttpFixture();

  it("preserves indented code and its blank line across newline-mode messages", async () => {
    const first = "A".repeat(128);
    const second = "B".repeat(128);
    await deliverReplies({
      cfg: fixture.cfg,
      bot: fixture.bot,
      runtime: fixture.runtime,
      chatId: "123",
      token: fixture.cfg.channels.telegram.botToken,
      replyToMode: "off",
      replies: [{ text: `    ${first}\n\n    ${second}` }],
      textLimit: 256,
      chunkMode: "newline",
      richMessages: false,
    });

    const code = fixture.requests
      .filter(({ method }) => method === "sendMessage")
      .map(({ fields }) => {
        if (typeof fields.text !== "string") {
          throw new Error("Expected a string Telegram sendMessage text");
        }
        const html = fields.text;
        expect(html.length).toBeLessThanOrEqual(256);
        expect(fields.parse_mode).toBe("HTML");
        expect(html).toMatch(/^<pre><code>[\s\S]+<\/code><\/pre>$/u);
        return html.slice("<pre><code>".length, -"</code></pre>".length);
      });
    expect(code.join("")).toBe(`${first}\n\n${second}\n`);
  });
});
