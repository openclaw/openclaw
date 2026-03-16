import { beforeEach, describe, expect, it, vi } from "vitest";

const handleTelegramActionMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/agents/tools/telegram-actions.js", () => ({
  handleTelegramAction: (...args: unknown[]) => handleTelegramActionMock(...args),
}));

import { telegramMessageActions } from "./channel-actions.js";

describe("telegramMessageActions", () => {
  beforeEach(() => {
    handleTelegramActionMock.mockReset().mockResolvedValue({
      ok: true,
      content: [],
      details: {},
    });
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
