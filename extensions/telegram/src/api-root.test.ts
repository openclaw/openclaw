// Telegram tests cover api root plugin behavior.
import { describe, expect, it } from "vitest";
import { hasTelegramBotEndpointApiRoot, normalizeTelegramApiRoot } from "./api-root.js";

const PUBLIC_TELEGRAM_API_ROOT = "https://api.telegram.org";

describe("telegram api root", () => {
  it("defaults to the public Telegram Bot API root", () => {
    expect(normalizeTelegramApiRoot()).toBe(PUBLIC_TELEGRAM_API_ROOT);
    expect(normalizeTelegramApiRoot("  ")).toBe(PUBLIC_TELEGRAM_API_ROOT);
  });

  it("keeps custom Bot API roots without a bot-token endpoint", () => {
    expect(normalizeTelegramApiRoot("https://telegram.internal:8443/custom-bot-api/")).toBe(
      "https://telegram.internal:8443/custom-bot-api",
    );
    expect(hasTelegramBotEndpointApiRoot("https://telegram.internal:8443/custom-bot-api/")).toBe(
      false,
    );
  });

  it("keeps bot-prefixed route names without a token", () => {
    expect(normalizeTelegramApiRoot("https://proxy.example.com/bot123456")).toBe(
      "https://proxy.example.com/bot123456",
    );
  });
});
