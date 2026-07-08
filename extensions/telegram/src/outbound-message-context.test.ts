import { describe, expect, it } from "vitest";
import { buildOutboundCacheMessage } from "./outbound-message-context.js";

describe("buildOutboundCacheMessage", () => {
  it("uses the configured self identity instead of the Telegram profile name", () => {
    const cacheMessage = buildOutboundCacheMessage({
      account: { accountId: "default", name: "Configured Agent" },
      chatId: 42,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_736_380_700,
        from: { id: 999, is_bot: true, first_name: "Provisioning Placeholder" },
        message_id: 700,
        text: "Bot just replied",
      },
      messageId: 700,
      text: "Bot just replied",
    });

    expect(cacheMessage.from).toEqual({
      id: 999,
      is_bot: true,
      first_name: "Configured Agent (you)",
    });
  });
});
