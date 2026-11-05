import { describe, expect, it, vi } from "vitest";
import { telegramReservedGatewayPaths } from "./test-support/webhook-fixtures.js";
import { startTelegramWebhook } from "./webhook.js";

const createTelegramBot = vi.hoisted(() => vi.fn());
vi.mock("./bot.js", () => ({ createTelegramBot }));

describe("Telegram webhook routes", () => {
  it.each([
    ...[undefined, false as const, { port: 8787 }].map((legacyWebhook) => ({
      path: "/healthz",
      legacyWebhook,
      error: /webhook path "\/healthz" conflicts with the health path/,
    })),
    ...telegramReservedGatewayPaths
      .filter((path) => ["/health", "/healthz?token=known", "/ready", "/startup"].includes(path))
      .map((path) => ({
        path,
        legacyWebhook: false as const,
        error: /webhook path.*reserved.*Gateway checks/i,
      })),
    ...["/api/channels/telegram", "/%61pi/channels/telegram"].map((path) => ({
      path,
      legacyWebhook: false as const,
      error: /requires Gateway authentication/,
    })),
  ])(
    "rejects $path with legacy listener $legacyWebhook",
    async ({ path, legacyWebhook, error }) => {
      await expect(
        startTelegramWebhook({ token: "tok", secret: "secret", path, legacyWebhook }),
      ).rejects.toThrow(error);
      expect(createTelegramBot).not.toHaveBeenCalled();
    },
  );
});
