import { describe, expect, it, vi } from "vitest";

const register = vi.hoisted(() => vi.fn());
// mock-isolation: a failing state store stands in for the plugin runtime database.
vi.mock("../runtime.js", () => ({
  getTelegramRuntime: () => ({
    state: { openKeyedStoreV2: () => ({ register, lookup: vi.fn() }) },
  }),
}));

const { recordTelegramSentWidget } = await import("./widget-store.js");

describe("recordTelegramSentWidget", () => {
  it("does not fail a widget Telegram already accepted when bookkeeping fails", async () => {
    register.mockRejectedValueOnce(new Error("state worker unavailable"));
    await expect(
      recordTelegramSentWidget({
        accountId: "default",
        chatId: "111",
        messageId: 42,
        widget: { name: "vote", sourceHash: "h", title: "Vote" },
      }),
    ).resolves.toBeUndefined();
    expect(register).toHaveBeenCalledOnce();
  });
});
