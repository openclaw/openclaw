import { describe, expect, it, vi } from "vitest";
import { telegramReservedGatewayPaths } from "./test-support/webhook-fixtures.js";
import { startTelegramWebhook } from "./webhook.js";

const createTelegramBot = vi.hoisted(() => vi.fn());
vi.mock("./bot.js", () => ({ createTelegramBot }));

describe("Telegram webhook routes", () => {
  it.each([undefined, false as const, { port: 8787 }])(
    "rejects the exact health path with legacy listener %j",
    async (legacyWebhook) => {
      await expect(
        startTelegramWebhook({ token: "tok", secret: "secret", path: "/healthz", legacyWebhook }),
      ).rejects.toThrow('webhook path "/healthz" conflicts with the health path');
      expect(createTelegramBot).not.toHaveBeenCalled();
    },
  );

  it.each(telegramReservedGatewayPaths.filter((path) => path !== "/healthz"))(
    "rejects reserved Gateway path %s",
    async (path) => {
      await expect(
        startTelegramWebhook({ token: "tok", secret: "secret", path, legacyWebhook: false }),
      ).rejects.toThrow(/webhook path.*reserved.*Gateway probes/i);
      expect(createTelegramBot).not.toHaveBeenCalled();
    },
  );

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
