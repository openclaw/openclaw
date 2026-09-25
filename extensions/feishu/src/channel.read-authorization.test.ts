import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const listPinsFeishuMock = vi.hoisted(() => vi.fn());
const getChatMembersMock = vi.hoisted(() => vi.fn());
const assertFeishuChatMemberMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    getChatInfo: getChatInfoMock,
    getMessageFeishu: getMessageFeishuMock,
    listPinsFeishu: listPinsFeishuMock,
    getChatMembers: getChatMembersMock,
    assertFeishuChatMember: assertFeishuChatMemberMock,
    getFeishuMemberInfo: getFeishuMemberInfoMock,
  },
}));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("feishuPlugin actions", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_main",
        appSecret: "secret_main",
        actions: { reactions: true },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.resetAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
    getChatInfoMock.mockResolvedValue({
      chat_id: "oc_group_1",
      chat_mode: "group",
      chat_type: "private",
    });
  });

  it.each([
    ["message reads", "read", { messageId: "om_unknown", chatId: "oc_unknown" }],
    ["pin lookup", "list-pins", { chatId: "oc_unknown" }],
    ["channel info", "channel-info", { chatId: "oc_unknown" }],
    ["member info", "member-info", { chatId: "oc_unknown", memberId: "ou_unknown" }],
  ])(
    "does not expose failed metadata lookup details for ambiguous Feishu %s",
    async (_name, action, params) => {
      getChatInfoMock.mockRejectedValueOnce(new Error("chat not found"));

      await expect(
        feishuPlugin.actions?.handleAction?.({
          action,
          params,
          cfg: {
            channels: {
              feishu: {
                appId: "cli_main",
                appSecret: "secret_main",
                groupPolicy: "open",
                dmPolicy: "pairing",
              },
            },
          } as OpenClawConfig,
        } as never),
      ).rejects.toThrow("Feishu read target is not allowed.");

      expect(getChatInfoMock).toHaveBeenCalledOnce();
      expect(getMessageFeishuMock).not.toHaveBeenCalled();
      expect(listPinsFeishuMock).not.toHaveBeenCalled();
      expect(getChatMembersMock).not.toHaveBeenCalled();
      expect(assertFeishuChatMemberMock).not.toHaveBeenCalled();
      expect(getFeishuMemberInfoMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { stage: "client acquisition", acquire: true, allowFrom: [] },
    { stage: "allowed metadata lookup", acquire: false, allowFrom: ["*"] },
  ])("preserves the original $stage failure", async ({ acquire, allowFrom }) => {
    const error = new Error("provider unavailable");
    if (acquire) {
      createFeishuClientMock.mockImplementationOnce(() => {
        throw error;
      });
    } else {
      getChatInfoMock.mockRejectedValueOnce(error);
    }

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "channel-info",
        params: { chatId: "oc_unknown" },
        cfg: {
          channels: {
            feishu: { ...cfg.channels?.feishu, dmPolicy: "pairing", allowFrom },
          },
        },
      } as never),
    ).rejects.toBe(error);
    expect(createFeishuClientMock).toHaveBeenCalledOnce();
    expect(getChatInfoMock).toHaveBeenCalledTimes(acquire ? 0 : 1);
  });
});
