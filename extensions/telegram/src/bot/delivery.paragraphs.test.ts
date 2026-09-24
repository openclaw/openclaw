import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseDeliveryParams,
  createBot,
  createRuntime,
  deliverReplies,
  loadWebMedia,
  resetDeliveryMocks,
} from "./delivery.test-support.js";

describe("Telegram reply paragraph delivery", () => {
  beforeEach(resetDeliveryMocks);

  it("preserves indented code and its blank line across newline-mode messages", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 4, chat: { id: "123" } });
    const first = "A".repeat(128);
    const second = "B".repeat(128);
    await deliverReplies({
      ...baseDeliveryParams,
      replies: [{ text: `    ${first}\n\n    ${second}` }],
      runtime: createRuntime(),
      bot: createBot({ sendMessage }),
      mediaLoader: loadWebMedia,
      textLimit: 256,
      chunkMode: "newline",
      richMessages: false,
    });

    const code = sendMessage.mock.calls.map((call) => {
      const html = call[1] as string;
      expect(html.length).toBeLessThanOrEqual(256);
      expect(call[2]).toMatchObject({ parse_mode: "HTML" });
      expect(html).toMatch(/^<pre><code>[\s\S]+<\/code><\/pre>$/u);
      return html.slice("<pre><code>".length, -"</code></pre>".length);
    });
    expect(code.join("")).toBe(`${first}\n\n${second}\n`);
  });
});
