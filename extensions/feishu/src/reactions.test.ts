// Feishu tests cover message reaction API behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { listReactionsFeishu } from "./reactions.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

function makeConfiguredCfg(): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        appId: "cli_test_app_id",
        appSecret: "cli_test_app_secret",
      },
    },
  } as ClawdbotConfig;
}

describe("listReactionsFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates Feishu message reactions", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              reaction_id: "reaction_a",
              reaction_type: { emoji_type: "THUMBSUP" },
              operator_type: "app",
              operator_id: { open_id: "ou_app" },
            },
          ],
          has_more: true,
          page_token: "p2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            {
              reaction_id: "reaction_b",
              reaction_type: { emoji_type: "HEART" },
              operator_type: "user",
              operator_id: { user_id: "user_b" },
            },
          ],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValue({
      im: {
        messageReaction: {
          list,
        },
      },
    });

    const reactions = await listReactionsFeishu({
      cfg: makeConfiguredCfg(),
      messageId: "om_msg1",
    });

    expect(reactions).toEqual([
      {
        reactionId: "reaction_a",
        emojiType: "THUMBSUP",
        operatorType: "app",
        operatorId: "ou_app",
      },
      {
        reactionId: "reaction_b",
        emojiType: "HEART",
        operatorType: "user",
        operatorId: "user_b",
      },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(2, {
      path: { message_id: "om_msg1" },
      params: { page_token: "p2" },
    });
  });
});
