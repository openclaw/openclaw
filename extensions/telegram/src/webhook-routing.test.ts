import { describe, expect, it, vi } from "vitest";
import { telegramReservedGatewayPaths } from "./test-support/webhook-fixtures.js";
import { startTelegramWebhook } from "./webhook.js";

const createTelegramBot = vi.hoisted(() => vi.fn());
vi.mock("./bot.js", () => ({ createTelegramBot }));

describe("Telegram Gateway-only webhook routes", () => {
  it.each(telegramReservedGatewayPaths)("rejects reserved Gateway path %s", async (path) => {
    await expect(
      startTelegramWebhook({ token: "tok", secret: "secret", path, legacyWebhook: false }),
    ).rejects.toThrow(/webhook path.*reserved.*Gateway probes/i);
    expect(createTelegramBot).not.toHaveBeenCalled();
  });

  it.each(["/api/channels/telegram", "/%61pi/channels/telegram"])(
    "rejects Gateway-authenticated path %s",
    async (path) => {
      await expect(
        startTelegramWebhook({ token: "tok", secret: "secret", path, legacyWebhook: false }),
      ).rejects.toThrow("requires Gateway authentication");
      expect(createTelegramBot).not.toHaveBeenCalled();
    },
  );
});
