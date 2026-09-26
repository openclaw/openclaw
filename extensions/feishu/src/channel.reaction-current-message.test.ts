import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";

const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    getMessageFeishu: getMessageFeishuMock,
    getChatInfo: getChatInfoMock,
  },
}));

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

const currentChatId = "oc_group_1";
const currentMessageId = "om_current_inbound";
const directChatId = "oc_direct_1";
const directSenderOpenId = "ou_sender_1";

// Build the tool context the way core does for a Feishu turn: the plugin's own
// threading adapter derives it, and buildThreadingToolContext then adds the
// provider plus the inbound message id the adapter does not claim
// (src/auto-reply/reply/agent-runner-utils.ts). A DM therefore reports the
// native chat id as the channel and the routable peer as the messaging target.
function buildFeishuToolContext(context: {
  To: string;
  NativeChannelId: string;
  ChatType: "direct" | "group";
}) {
  const build = feishuPlugin.threading?.buildToolContext;
  if (!build) {
    throw new Error("Feishu threading.buildToolContext unavailable");
  }
  return {
    ...build({ cfg, context } as never),
    currentChannelProvider: "feishu",
    currentMessageId,
  };
}

const groupToolContext = buildFeishuToolContext({
  To: `chat:${currentChatId}`,
  NativeChannelId: currentChatId,
  ChatType: "group",
});

const directToolContext = buildFeishuToolContext({
  To: `user:${directSenderOpenId}`,
  NativeChannelId: directChatId,
  ChatType: "direct",
});

async function runAction(
  action: "react" | "reactions",
  params: Record<string, unknown>,
  toolContext: Record<string, unknown> = groupToolContext,
) {
  return await feishuPlugin.actions?.handleAction?.({
    action,
    params,
    cfg,
    accountId: undefined,
    toolContext,
  } as never);
}

describe("feishu current-message reactions", () => {
  function mockInboundMessage(chatId: string, chatType: "group" | "p2p") {
    getChatInfoMock.mockResolvedValue({
      chat_id: chatId,
      chat_mode: chatType,
      chat_type: "private",
    });
    getMessageFeishuMock.mockResolvedValue({
      messageId: currentMessageId,
      chatId,
      chatType,
      content: "hello",
      contentType: "text",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
    mockInboundMessage(currentChatId, "group");
  });

  it("adds a reaction to the current inbound message when messageId is omitted", async () => {
    await runAction("react", { emoji: "THUMBSUP" });
    expect(addReactionFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: currentMessageId,
      emojiType: "THUMBSUP",
      accountId: undefined,
    });
  });

  it("lists reactions of the current inbound message when messageId is omitted", async () => {
    listReactionsFeishuMock.mockResolvedValueOnce([]);
    await runAction("reactions", {});
    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: currentMessageId,
      accountId: undefined,
    });
  });

  it("adds a reaction to the current inbound message in a direct chat", async () => {
    mockInboundMessage(directChatId, "p2p");
    await runAction("react", { emoji: "THUMBSUP" }, directToolContext);
    expect(addReactionFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: currentMessageId,
      emojiType: "THUMBSUP",
      accountId: undefined,
    });
  });

  it("adds a reaction when a direct chat names its routable peer target", async () => {
    mockInboundMessage(directChatId, "p2p");
    await runAction(
      "react",
      { to: `user:${directSenderOpenId}`, emoji: "THUMBSUP" },
      directToolContext,
    );
    expect(addReactionFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: currentMessageId,
      emojiType: "THUMBSUP",
      accountId: undefined,
    });
  });

  it("still requires an explicit messageId for a different conversation", async () => {
    await expect(
      runAction("react", { to: "chat:oc_other_group", emoji: "THUMBSUP" }),
    ).rejects.toThrow("Feishu reaction requires messageId.");
    expect(addReactionFeishuMock).not.toHaveBeenCalled();
  });

  it("still requires an explicit messageId for another peer from a direct chat", async () => {
    mockInboundMessage(directChatId, "p2p");
    await expect(
      runAction("react", { to: "user:ou_other_peer", emoji: "THUMBSUP" }, directToolContext),
    ).rejects.toThrow("Feishu reaction requires messageId.");
    expect(addReactionFeishuMock).not.toHaveBeenCalled();
  });
});
