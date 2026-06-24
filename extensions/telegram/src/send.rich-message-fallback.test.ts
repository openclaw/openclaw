// Telegram send tests cover rich-message fallback behavior.
import { describe, expect, it } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";

installTelegramSendTestHooks();

const { botApi, botRawApi } = getTelegramSendTestMocks();
const { sendMessageTelegram } = await importTelegramSendModule();

describe("sendMessageTelegram rich-message fallback", () => {
  it("falls back to plain text when Telegram rejects rich-message email entities", async () => {
    const richError = Object.assign(new Error("Bad Request: RICH_MESSAGE_EMAIL_INVALID"), {
      error_code: 400,
    });
    botRawApi.sendRichMessage.mockRejectedValueOnce(richError);
    botApi.sendMessage.mockResolvedValue({ message_id: 52, chat: { id: "123" } });
    const statusText =
      "OpenAI auth profile: openai:keshavbotagent@gmail.com (keshavbotagent@gmail.com)";

    await sendMessageTelegram("123", statusText, {
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
          },
        },
      },
      token: "tok",
      verbose: true,
    });

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).toHaveBeenCalledWith("123", statusText);
  });

  it("does not hide unrelated rich-message send failures", async () => {
    const richError = Object.assign(new Error("Bad Request: chat not found"), {
      error_code: 400,
    });
    botRawApi.sendRichMessage.mockRejectedValueOnce(richError);

    await expect(
      sendMessageTelegram("123", "plain status text", {
        cfg: {
          channels: {
            telegram: {
              richMessages: true,
            },
          },
        },
        token: "tok",
      }),
    ).rejects.toThrow("chat not found");

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });
});
