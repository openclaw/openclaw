import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const messageReactionListMock = vi.hoisted(() => vi.fn());

vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: vi.fn(() => ({
    accountId: "default",
    configured: true,
    appId: "app_id",
    appSecret: "app_secret",
    domain: "feishu",
    config: {},
  })),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({
    im: {
      messageReaction: {
        list: messageReactionListMock,
      },
    },
  })),
}));

describe("listReactionsFeishu", () => {
  beforeEach(() => {
    messageReactionListMock.mockReset();
  });

  it("reads Feishu SDK nested operator metadata", async () => {
    const { listReactionsFeishu } = await import("./reactions.js");
    messageReactionListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "ri_typing_1",
            reaction_type: { emoji_type: "Typing" },
            operator: {
              operator_type: "app",
              operator_id: "cli_app_1",
            },
          },
        ],
      },
    });

    await expect(
      listReactionsFeishu({
        cfg: {} as ClawdbotConfig,
        messageId: "om_message_1",
      }),
    ).resolves.toEqual([
      {
        reactionId: "ri_typing_1",
        emojiType: "Typing",
        operatorType: "app",
        operatorId: "cli_app_1",
      },
    ]);
  });
});
