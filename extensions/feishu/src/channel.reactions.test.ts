import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { feishuPlugin } from "../channel-plugin-api.js";
import type { OpenClawConfig } from "../runtime-api.js";

const addReactionFeishu = vi.hoisted(() => vi.fn());
const listReactionsFeishu = vi.hoisted(() => vi.fn());
const getMessageFeishu = vi.hoisted(() => vi.fn());

// mock-isolation: no Lark HTTP client may be created in this unit test.
vi.mock("./client.js", () => ({ createFeishuClient: vi.fn(() => ({ tag: "client" })) }));
// mock-isolation: records the Lark API calls instead of sending them.
vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: { addReactionFeishu, listReactionsFeishu, getMessageFeishu },
}));

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

const cfg = {
  channels: { feishu: { appId: "cli_main", appSecret: "secret_main", groupPolicy: "open" } },
} satisfies OpenClawConfig;
const inbound = {
  channel: "feishu" as const,
  cfg,
  accountId: "default",
  requesterAccountId: "default",
  toolContext: {
    currentChannelProvider: "feishu",
    currentChannelId: "oc_group_1",
    currentChatType: "group" as const,
    currentMessageId: "om_inbound",
  },
};
const run = (action: "react" | "reactions", params: Record<string, unknown>) =>
  feishuPlugin.actions!.handleAction!({ ...inbound, action, params });

describe("Feishu reactions on the current message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMessageFeishu.mockResolvedValue({
      messageId: "om_inbound",
      chatId: "oc_group_1",
      chatType: "group",
      content: "hello",
      contentType: "text",
    });
    listReactionsFeishu.mockResolvedValue([]);
  });

  it("defaults to the inbound message within its conversation", async () => {
    await run("react", { emoji: "THUMBSUP" });
    await run("reactions", { chatId: "chat:oc_group_1" });
    expect(addReactionFeishu.mock.calls[0]?.[0]).toMatchObject({ messageId: "om_inbound" });
    expect(listReactionsFeishu.mock.calls[0]?.[0]).toMatchObject({ messageId: "om_inbound" });
  });

  it("still requires messageId for another conversation", async () => {
    await expect(run("react", { emoji: "THUMBSUP", chatId: "oc_other" })).rejects.toThrow(
      "requires messageId",
    );
    expect(addReactionFeishu).not.toHaveBeenCalled();
  });
});
