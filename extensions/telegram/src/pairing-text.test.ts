import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { telegramPairingText } from "./pairing-text.js";
import { clearTelegramRuntime, setTelegramRuntime } from "./runtime.js";

function createCfg(): OpenClawConfig {
  return {
    channels: {
      telegram: {
        enabled: true,
        accounts: {
          ops: { botToken: "token-ops" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("telegramPairingText", () => {
  it("preserves accountId for pairing approval sends", async () => {
    const sendMessageTelegram = vi.fn(async () => ({ messageId: "tg-pair", chatId: "12345" }));
    const resolveTelegramToken = vi.fn(async () => ({ token: "token-ops", source: "config" }));
    setTelegramRuntime({
      channel: {
        telegram: {
          sendMessageTelegram,
          resolveTelegramToken,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as never);

    await telegramPairingText.notify({
      cfg: createCfg(),
      id: "12345",
      message: "approved",
      accountId: "ops",
    });

    expect(resolveTelegramToken).toHaveBeenCalledWith(createCfg(), {
      accountId: "ops",
    });
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "12345",
      "approved",
      expect.objectContaining({
        token: "token-ops",
        accountId: "ops",
      }),
    );
    clearTelegramRuntime();
  });
});
