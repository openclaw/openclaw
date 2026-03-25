import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const addReactionFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());
const removeReactionFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const editMessageFeishuMock = vi.hoisted(() => vi.fn());
const createPinFeishuMock = vi.hoisted(() => vi.fn());
const listPinsFeishuMock = vi.hoisted(() => vi.fn());
const removePinFeishuMock = vi.hoisted(() => vi.fn());
const getChatInfoMock = vi.hoisted(() => vi.fn());
const getChatMembersMock = vi.hoisted(() => vi.fn());
const getFeishuMemberInfoMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryPeersLiveMock = vi.hoisted(() => vi.fn());
const listFeishuDirectoryGroupsLiveMock = vi.hoisted(() => vi.fn());
const feishuOutboundSendMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    addReactionFeishu: addReactionFeishuMock,
    createPinFeishu: createPinFeishuMock,
    editMessageFeishu: editMessageFeishuMock,
    getChatInfo: getChatInfoMock,
    getChatMembers: getChatMembersMock,
    getFeishuMemberInfo: getFeishuMemberInfoMock,
    getMessageFeishu: getMessageFeishuMock,
    listFeishuDirectoryGroupsLive: listFeishuDirectoryGroupsLiveMock,
    listFeishuDirectoryPeersLive: listFeishuDirectoryPeersLiveMock,
    listPinsFeishu: listPinsFeishuMock,
    listReactionsFeishu: listReactionsFeishuMock,
    probeFeishu: probeFeishuMock,
    removePinFeishu: removePinFeishuMock,
    removeReactionFeishu: removeReactionFeishuMock,
    sendCardFeishu: sendCardFeishuMock,
    sendMessageFeishu: sendMessageFeishuMock,
    feishuOutbound: {
      sendText: vi.fn(),
      sendMedia: feishuOutboundSendMediaMock,
    },
  },
}));

import { feishuPlugin } from "./channel.js";

function getDescribedActions(cfg: OpenClawConfig): string[] {
  return [...(feishuPlugin.actions?.describeMessageTool?.({ cfg })?.actions ?? [])];
}

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});

describe("feishuPlugin actions", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_main",
        appSecret: "secret_main",
        actions: {
          reactions: true,
        },
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({ tag: "client" });
  });

  it("advertises the expanded Feishu action surface", () => {
    expect(getDescribedActions(cfg)).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
      "react",
      "reactions",
    ]);
  });

  it("does not advertise reactions when disabled via actions config", () => {
    const disabledCfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_main",
          appSecret: "secret_main",
          actions: {
            reactions: false,
          },
        },
      },
    } as OpenClawConfig;

    expect(getDescribedActions(disabledCfg)).toEqual([
      "send",
      "read",
      "edit",
      "thread-reply",
      "pin",
      "list-pins",
      "unpin",
      "member-info",
      "channel-info",
      "channel-list",
    ]);
  });

  it("sends text messages", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_sent", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", message: "hello" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "hello",
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_sent", chatId: "oc_group_1" });
  });

  it("sends card messages", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: { to: "chat:oc_group_1", card: { schema: "2.0" } },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendCardFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      card: { schema: "2.0" },
      accountId: undefined,
      replyToMessageId: undefined,
      replyInThread: false,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_card", chatId: "oc_group_1" });
  });

  it("sends media through the outbound adapter", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media",
      details: { messageId: "om_media", chatId: "oc_group_1" },
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        message: "test",
        media: "/tmp/image.png",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: ["/tmp"],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "test",
      mediaUrl: "/tmp/image.png",
      accountId: undefined,
      mediaLocalRoots: ["/tmp"],
      replyToId: undefined,
    });
    expect(result?.details).toMatchObject({ messageId: "om_media" });
  });

  it("reads messages", async () => {
    getMessageFeishuMock.mockResolvedValueOnce({
      messageId: "om_1",
      content: "hello",
      contentType: "text",
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "read",
      params: { messageId: "om_1" },
      cfg,
      accountId: undefined,
    } as never);

    expect(getMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_1",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      message: expect.objectContaining({ messageId: "om_1", content: "hello" }),
    });
  });

  it("returns an error result when message reads fail", async () => {
    getMessageFeishuMock.mockResolvedValueOnce(null);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "read",
      params: { messageId: "om_missing" },
      cfg,
      accountId: undefined,
    } as never);

    expect((result as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect(result?.details).toEqual({
      error: "Feishu read failed or message not found: om_missing",
    });
  });

  it("edits messages", async () => {
    editMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_2", contentType: "post" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "edit",
      params: { messageId: "om_2", text: "updated" },
      cfg,
      accountId: undefined,
    } as never);

    expect(editMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_2",
      text: "updated",
      card: undefined,
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_2", contentType: "post" });
  });

  it("sends explicit thread replies with reply_in_thread semantics", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_reply", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "thread-reply",
      params: { to: "chat:oc_group_1", messageId: "om_parent", text: "reply body" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg,
      to: "chat:oc_group_1",
      text: "reply body",
      accountId: undefined,
      replyToMessageId: "om_parent",
      replyInThread: true,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      action: "thread-reply",
      messageId: "om_reply",
    });
  });

  it("creates pins", async () => {
    createPinFeishuMock.mockResolvedValueOnce({ messageId: "om_pin", chatId: "oc_group_1" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "pin",
      params: { messageId: "om_pin" },
      cfg,
      accountId: undefined,
    } as never);

    expect(createPinFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_pin",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      pin: expect.objectContaining({ messageId: "om_pin" }),
    });
  });

  it("lists pins", async () => {
    listPinsFeishuMock.mockResolvedValueOnce({
      chatId: "oc_group_1",
      pins: [{ messageId: "om_pin" }],
      hasMore: false,
      pageToken: undefined,
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "list-pins",
      params: { chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(listPinsFeishuMock).toHaveBeenCalledWith({
      cfg,
      chatId: "oc_group_1",
      startTime: undefined,
      endTime: undefined,
      pageSize: undefined,
      pageToken: undefined,
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      pins: [expect.objectContaining({ messageId: "om_pin" })],
    });
  });

  it("removes pins", async () => {
    const result = await feishuPlugin.actions?.handleAction?.({
      action: "unpin",
      params: { messageId: "om_pin" },
      cfg,
      accountId: undefined,
    } as never);

    expect(removePinFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_pin",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({ ok: true, messageId: "om_pin" });
  });

  it("fetches channel info", async () => {
    getChatInfoMock.mockResolvedValueOnce({ chat_id: "oc_group_1", name: "Eng" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "channel-info",
      params: { chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(createFeishuClientMock).toHaveBeenCalled();
    expect(getChatInfoMock).toHaveBeenCalledWith({ tag: "client" }, "oc_group_1");
    expect(result?.details).toMatchObject({
      ok: true,
      channel: expect.objectContaining({ chat_id: "oc_group_1", name: "Eng" }),
    });
  });

  it("fetches member lists from a chat", async () => {
    getChatMembersMock.mockResolvedValueOnce({
      chat_id: "oc_group_1",
      members: [{ member_id: "ou_1", name: "Alice" }],
      has_more: false,
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { chatId: "oc_group_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getChatMembersMock).toHaveBeenCalledWith(
      { tag: "client" },
      "oc_group_1",
      undefined,
      undefined,
      "open_id",
    );
    expect(result?.details).toMatchObject({
      ok: true,
      members: [expect.objectContaining({ member_id: "ou_1", name: "Alice" })],
    });
  });

  it("fetches individual member info", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "ou_1", name: "Alice" });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { memberId: "ou_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "ou_1", "open_id");
    expect(result?.details).toMatchObject({
      ok: true,
      member: expect.objectContaining({ member_id: "ou_1", name: "Alice" }),
    });
  });

  it("infers user_id lookups from the userId alias", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { userId: "u_1" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "u_1", "user_id");
  });

  it("honors explicit open_id over alias heuristics", async () => {
    getFeishuMemberInfoMock.mockResolvedValueOnce({ member_id: "u_1", name: "Alice" });

    await feishuPlugin.actions?.handleAction?.({
      action: "member-info",
      params: { userId: "u_1", memberIdType: "open_id" },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    expect(getFeishuMemberInfoMock).toHaveBeenCalledWith({ tag: "client" }, "u_1", "open_id");
  });

  it("lists directory-backed peers and groups", async () => {
    listFeishuDirectoryGroupsLiveMock.mockResolvedValueOnce([{ kind: "group", id: "oc_group_1" }]);
    listFeishuDirectoryPeersLiveMock.mockResolvedValueOnce([{ kind: "user", id: "ou_1" }]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "channel-list",
      params: { query: "eng", limit: 5 },
      cfg,
      accountId: undefined,
    } as never);

    expect(listFeishuDirectoryGroupsLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: 5,
      fallbackToStatic: false,
      accountId: undefined,
    });
    expect(listFeishuDirectoryPeersLiveMock).toHaveBeenCalledWith({
      cfg,
      query: "eng",
      limit: 5,
      fallbackToStatic: false,
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({
      ok: true,
      groups: [expect.objectContaining({ id: "oc_group_1" })],
      peers: [expect.objectContaining({ id: "ou_1" })],
    });
  });

  it("fails channel-list when live discovery fails", async () => {
    listFeishuDirectoryGroupsLiveMock.mockRejectedValueOnce(new Error("token expired"));

    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "channel-list",
        params: { query: "eng", limit: 5, scope: "groups" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow("token expired");
  });

  it("requires clearAll=true before removing all bot reactions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "react",
        params: { messageId: "om_msg1" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow(
      "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
    );
  });

  it("allows explicit clearAll=true when removing all bot reactions", async () => {
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r1", operatorType: "app" },
      { reactionId: "r2", operatorType: "app" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: { messageId: "om_msg1", clearAll: true },
      cfg,
      accountId: undefined,
    } as never);

    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      accountId: undefined,
    });
    expect(removeReactionFeishuMock).toHaveBeenCalledTimes(2);
    expect(result?.details).toMatchObject({ ok: true, removed: 2 });
  });

  it("fails for missing params on supported actions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "thread-reply",
        params: { to: "chat:oc_group_1", message: "reply body" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow("Feishu thread-reply requires messageId.");
  });

  it("sends media-only messages without requiring card", async () => {
    feishuOutboundSendMediaMock.mockResolvedValueOnce({
      channel: "feishu",
      messageId: "om_media_only",
      details: { messageId: "om_media_only", chatId: "oc_group_1" },
    });

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        media: "https://example.com/image.png",
      },
      cfg,
      accountId: undefined,
      toolContext: {},
      mediaLocalRoots: [],
    } as never);

    expect(feishuOutboundSendMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_group_1",
        mediaUrl: "https://example.com/image.png",
      }),
    );
    expect(result?.details).toMatchObject({ messageId: "om_media_only" });
  });

  it("fails for unsupported action names", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "search",
        params: {},
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow('Unsupported Feishu action: "search"');
  });
});
