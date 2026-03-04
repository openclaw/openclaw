vi.mock("ccxt", () => ({}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotificationRouter } from "../../src/core/notification-router.js";

describe("Telegram chat_id resolution", () => {
  it("returns chat_id when configured", async () => {
    const chatId = await NotificationRouter.resolveChatId({
      telegramChatId: "123456",
    });
    expect(chatId).toBe("123456");
  });

  it("returns undefined without chat_id (graceful degradation)", async () => {
    const chatId = await NotificationRouter.resolveChatId({
      telegramChatId: "",
    });
    expect(chatId).toBeUndefined();
  });
});
