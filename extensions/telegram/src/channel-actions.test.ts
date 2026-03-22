import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramMessageActions, telegramMessageActionRuntime } from "./channel-actions.js";

const handleTelegramActionMock = vi.hoisted(() => vi.fn());
const originalHandleTelegramAction = telegramMessageActionRuntime.handleTelegramAction;

describe("telegramMessageActions", () => {
  beforeEach(() => {
    handleTelegramActionMock.mockReset().mockResolvedValue({
      ok: true,
      content: [],
      details: {},
    });
    telegramMessageActionRuntime.handleTelegramAction = (...args) =>
      handleTelegramActionMock(...args);
  });

  afterEach(() => {
    telegramMessageActionRuntime.handleTelegramAction = originalHandleTelegramAction;
  });

  it("allows interactive-only sends", async () => {
    await telegramMessageActions.handleAction!({
      action: "send",
      params: {
        to: "123456",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve", style: "success" }],
            },
          ],
        },
      },
      cfg: {} as never,
      accountId: "default",
      mediaLocalRoots: [],
    } as never);

    expect(handleTelegramActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "123456",
        content: "",
        buttons: [[{ text: "Approve", callback_data: "approve", style: "success" }]],
        accountId: "default",
      }),
      expect.anything(),
      expect.objectContaining({
        mediaLocalRoots: [],
      }),
    );
  });
});
