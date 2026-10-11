import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  CHANNEL_TO,
  CHAT_ID,
  TOKEN,
  type GraphMessagesTestModule,
  getGraphMessagesMockState,
  installGraphMessagesMockDefaults,
  loadGraphMessagesTestModule,
} from "./graph-messages.test-helpers.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let getMessageMSTeams: GraphMessagesTestModule["getMessageMSTeams"];
let listPinsMSTeams: GraphMessagesTestModule["listPinsMSTeams"];
let listReactionsMSTeams: GraphMessagesTestModule["listReactionsMSTeams"];
let pinMessageMSTeams: GraphMessagesTestModule["pinMessageMSTeams"];
let reactMessageMSTeams: GraphMessagesTestModule["reactMessageMSTeams"];
let unpinMessageMSTeams: GraphMessagesTestModule["unpinMessageMSTeams"];
let unreactMessageMSTeams: GraphMessagesTestModule["unreactMessageMSTeams"];
let searchMessagesMSTeams: GraphMessagesTestModule["searchMessagesMSTeams"];

const NAMED_ACCOUNT_CFG = {
  channels: {
    msteams: {
      appId: "default-app-id",
      appPassword: "default-secret",
      tenantId: "tenant-id",
      accounts: {
        secondary: {
          appId: "secondary-app-id",
          appPassword: "secondary-secret",
          webhook: { path: "/api/messages/secondary" },
        },
      },
    },
  },
} as OpenClawConfig;

beforeAll(async () => {
  ({
    getMessageMSTeams,
    listPinsMSTeams,
    listReactionsMSTeams,
    pinMessageMSTeams,
    reactMessageMSTeams,
    unpinMessageMSTeams,
    unreactMessageMSTeams,
    searchMessagesMSTeams,
  } = await loadGraphMessagesTestModule());
});

describe("getMessageMSTeams", () => {
  it("resolves user targets whose stored conversation ID is Graph-native", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "19:resolved-chat@thread.tacv2",
      reference: {},
    });
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      createdDateTime: "2026-03-23T10:00:00Z",
    });

    await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: "user:aad-id",
      messageId: "msg-1",
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:resolved-chat@thread.tacv2")}/messages/msg-1`,
    });
  });

  it("throws when user: target has no stored conversation", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue(null);

    await expect(
      getMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "user:unknown-user",
        messageId: "msg-1",
      }),
    ).rejects.toThrow("No conversation found for user:unknown-user");
  });

  it("throws when user: target has an opaque Bot Framework ID", async () => {
    mockState.findPreferredDmByUserId.mockResolvedValue({
      conversationId: "a:bot-framework-dm-id",
      reference: {},
    });

    await expect(
      getMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: "user:some-user",
        messageId: "msg-1",
      }),
    ).rejects.toThrow("Bot Framework ID");
  });

  it("reads a message from a conversation-prefixed chat target", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello world", contentType: "text" },
      from: { user: { id: "user-1", displayName: "Alice" } },
      createdDateTime: "2026-03-23T10:00:00Z",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: `conversation:${CHAT_ID}`,
      messageId: "msg-1",
    });

    expect(result).toEqual({
      id: "msg-1",
      text: "Hello world",
      from: { user: { id: "user-1", displayName: "Alice" } },
      createdAt: "2026-03-23T10:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/messages/msg-1`,
    });
  });

  it("reads a message from a channel conversation", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-2",
      body: { content: "Channel message" },
      from: { application: { id: "app-1", displayName: "Bot" } },
      createdDateTime: "2026-03-23T11:00:00Z",
    });

    const result = await getMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
    });

    expect(result).toEqual({
      id: "msg-2",
      text: "Channel message",
      from: { application: { id: "app-1", displayName: "Bot" } },
      createdAt: "2026-03-23T11:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
    });
  });

  it("resolves Graph tokens with the named account id", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello world" },
    });

    await getMessageMSTeams({
      cfg: NAMED_ACCOUNT_CFG,
      accountId: "secondary",
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(mockState.resolveGraphToken).toHaveBeenCalledWith(NAMED_ACCOUNT_CFG, {
      accountId: "secondary",
    });
  });
});

describe("listPinsMSTeams", () => {
  it("returns empty array when no pins exist", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toStrictEqual([]);
  });

  it("follows @odata.nextLink pagination", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [{ id: "pinned-1", message: { id: "msg-1", body: { content: "First page" } } }],
      "@odata.nextLink":
        "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/pinnedMessages?$expand=message&$skiptoken=page2",
    });
    mockState.fetchGraphAbsoluteUrl.mockResolvedValue({
      value: [{ id: "pinned-2", message: { id: "msg-2", body: { content: "Second page" } } }],
    });

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toEqual([
      { id: "pinned-1", pinnedMessageId: "pinned-1", messageId: "msg-1", text: "First page" },
      { id: "pinned-2", pinnedMessageId: "pinned-2", messageId: "msg-2", text: "Second page" },
    ]);
    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledWith({
      token: TOKEN,
      url: "https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.tacv2/pinnedMessages?$expand=message&$skiptoken=page2",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages?$expand=message`,
    });
  });

  it("stops paginating after max pages", async () => {
    const makePageResponse = (pageNum: number) => ({
      value: [
        {
          id: `pinned-${pageNum}`,
          message: { id: `msg-${pageNum}`, body: { content: `Page ${pageNum}` } },
        },
      ],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/next?page=${pageNum + 1}`,
    });

    mockState.fetchGraphJson.mockResolvedValue(makePageResponse(1));
    for (let i = 2; i <= 10; i++) {
      mockState.fetchGraphAbsoluteUrl.mockResolvedValueOnce(makePageResponse(i));
    }

    const result = await listPinsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
    });

    expect(result.pins).toHaveLength(10);
    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledTimes(9);
  });

  it("throws for channel list-pins (not supported on Graph v1.0)", async () => {
    await expect(
      listPinsMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
      }),
    ).rejects.toThrow("not supported for channels");
  });

  it("resolves Graph tokens with the named account id", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    await listPinsMSTeams({
      cfg: NAMED_ACCOUNT_CFG,
      accountId: "secondary",
      to: CHAT_ID,
    });

    expect(mockState.resolveGraphToken).toHaveBeenCalledWith(NAMED_ACCOUNT_CFG, {
      accountId: "secondary",
    });
  });
});

describe("listReactionsMSTeams", () => {
  it("lists reactions grouped by type with user details", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      reactions: [
        { reactionType: "like", user: { id: "u1", displayName: "Alice" } },
        { reactionType: "like", user: { id: "u2", displayName: "Bob" } },
        { reactionType: "heart", user: { id: "u1", displayName: "Alice" } },
      ],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result.reactions).toEqual([
      {
        reactionType: "like",
        name: "like",
        emoji: "\u{1F44D}",
        count: 2,
        users: [
          { id: "u1", displayName: "Alice" },
          { id: "u2", displayName: "Bob" },
        ],
      },
      {
        reactionType: "heart",
        name: "heart",
        emoji: "\u2764\uFE0F",
        count: 1,
        users: [{ id: "u1", displayName: "Alice" }],
      },
    ]);
  });

  it("returns empty array when message has no reactions", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "No reactions" },
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result.reactions).toStrictEqual([]);
  });

  it("counts reactions from users without an ID", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      reactions: [
        { reactionType: "like", user: { id: "u1", displayName: "Alice" } },
        { reactionType: "like", user: { displayName: "Deleted User" } },
        { reactionType: "like", user: undefined },
        { reactionType: "like" },
        { reactionType: "heart", user: { id: "u2", displayName: "Bob" } },
      ],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result.reactions).toEqual([
      {
        reactionType: "like",
        name: "like",
        emoji: "\u{1F44D}",
        count: 4,
        users: [{ id: "u1", displayName: "Alice" }],
      },
      {
        reactionType: "heart",
        name: "heart",
        emoji: "\u2764\uFE0F",
        count: 1,
        users: [{ id: "u2", displayName: "Bob" }],
      },
    ]);
  });

  it("fetches from channel path for channel targets", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-2",
      body: { content: "Channel msg" },
      reactions: [{ reactionType: "surprised", user: { id: "u3", displayName: "Carol" } }],
    });

    const result = await listReactionsMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      messageId: "msg-2",
    });

    expect(result.reactions).toEqual([
      {
        reactionType: "surprised",
        name: "surprised",
        emoji: "\u{1F62E}",
        count: 1,
        users: [{ id: "u3", displayName: "Carol" }],
      },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: "/teams/team-id-1/channels/channel-id-1/messages/msg-2",
    });
  });

  it("resolves Graph tokens with the named account id", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "msg-1",
      body: { content: "Hello" },
      reactions: [],
    });

    await listReactionsMSTeams({
      cfg: NAMED_ACCOUNT_CFG,
      accountId: "secondary",
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(mockState.resolveGraphToken).toHaveBeenCalledWith(NAMED_ACCOUNT_CFG, {
      accountId: "secondary",
    });
  });
});

describe("MSTeams reaction validation", () => {
  it("rejects empty reaction types", async () => {
    await expect(
      reactMessageMSTeams({
        cfg: {},
        to: CHAT_ID,
        messageId: "msg-1",
        reactionType: "   ",
      }),
    ).rejects.toThrow(/Reaction type is required/);
  });
});

describe("pinMessageMSTeams", () => {
  it("pins a message in a chat via message@odata.bind body", async () => {
    mockState.mutateGraphJson.mockResolvedValue({ id: "pinned-1" });

    const result = await pinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      messageId: "msg-1",
    });

    expect(result).toEqual({ ok: true, pinnedMessageId: "pinned-1" });
    expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages`,
      method: "POST",
      body: {
        "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(
          CHAT_ID,
        )}/messages/${encodeURIComponent("msg-1")}`,
      },
    });
  });

  it("rejects pinning a message in a channel on Graph v1.0", async () => {
    await expect(
      pinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        messageId: "msg-2",
      }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.mutateGraphJson).not.toHaveBeenCalled();
  });
});

describe("unpinMessageMSTeams", () => {
  it("unpins a message from a chat", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await unpinMessageMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      pinnedMessageId: "pinned-1",
    });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent(CHAT_ID)}/pinnedMessages/${encodeURIComponent("pinned-1")}`,
    });
  });

  it("rejects unpinning a message from a channel on Graph v1.0", async () => {
    await expect(
      unpinMessageMSTeams({
        cfg: {} as OpenClawConfig,
        to: CHANNEL_TO,
        pinnedMessageId: "pinned-2",
      }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.deleteGraphRequest).not.toHaveBeenCalled();
  });
});

describe("MSTeams reactions", () => {
  it.each([
    {
      operation: "react",
      to: CHAT_ID,
      path: `/chats/${encodeURIComponent(CHAT_ID)}`,
      reactionType: " LAUGH ",
      expected: "😆",
      action: "setReaction",
    },

    {
      operation: "unreact",
      to: CHANNEL_TO,
      path: "/teams/team-id-1/channels/channel-id-1",
      reactionType: " 🎉 ",
      expected: "🎉",
      action: "unsetReaction",
    },
  ])(
    "$operation normalizes $reactionType for $to",
    async ({ operation, to, path, reactionType, expected, action }) => {
      mockState.mutateGraphJson.mockResolvedValue(undefined);
      const invoke = operation === "react" ? reactMessageMSTeams : unreactMessageMSTeams;
      await expect(invoke({ cfg: {}, to, messageId: "msg-1", reactionType })).resolves.toEqual({
        ok: true,
      });
      expect(mockState.resolveGraphToken).toHaveBeenCalledWith(
        {},
        { preferDelegated: true, accountId: undefined },
      );
      expect(mockState.mutateGraphJson).toHaveBeenCalledWith({
        token: TOKEN,
        path: `${path}/messages/msg-1/${action}`,
        method: "POST",
        body: { reactionType: expected },
        beta: true,
      });
    },
  );
});

function readFirstGraphPath(): string {
  const request = mockState.fetchGraphJson.mock.calls[0]?.[0];
  if (!request || typeof request.path !== "string") {
    throw new Error("Expected Graph fetch request path");
  }
  return request.path;
}

describe("searchMessagesMSTeams", () => {
  it("searches with the selected account token", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });
    await searchMessagesMSTeams({
      cfg: NAMED_ACCOUNT_CFG,
      accountId: "secondary",
      to: CHAT_ID,
      query: "hello",
    });
    expect(mockState.resolveGraphToken).toHaveBeenCalledWith(NAMED_ACCOUNT_CFG, {
      accountId: "secondary",
    });
  });

  it("filters chat messages locally and normalizes HTML content", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "<p>Meeting <b>notes</b> from Monday</p>", contentType: "html" },
          from: { user: { id: "u1", displayName: "Alice" } },
          createdDateTime: "2026-03-25T10:00:00Z",
        },
        {
          id: "msg-2",
          body: { content: "Unrelated update", contentType: "text" },
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "meeting notes",
    });

    expect(result).toEqual({
      messages: [
        {
          id: "msg-1",
          text: "<p>Meeting <b>notes</b> from Monday</p>",
          from: { user: { id: "u1", displayName: "Alice" } },
          createdAt: "2026-03-25T10:00:00Z",
        },
      ],
      truncated: false,
    });
    expect(readFirstGraphPath()).toBe(`/chats/${encodeURIComponent(CHAT_ID)}/messages?$top=50`);
  });

  it("keeps channel search scoped to the selected channel", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [{ id: "msg-2", body: { content: "Sprint review" } }],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHANNEL_TO,
      query: "sprint",
    });

    expect(result.messages).toHaveLength(1);
    expect(readFirstGraphPath()).toBe("/teams/team-id-1/channels/channel-id-1/messages?$top=50");
  });

  it("follows target-scoped pagination and applies sender matching locally", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "wrong-sender",
          body: { content: "budget update" },
          from: { user: { id: "u1", displayName: "Bob" } },
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
    });
    mockState.fetchGraphAbsoluteUrl.mockResolvedValue({
      value: [
        {
          id: "right-sender",
          body: { content: "Budget update" },
          from: { application: { id: "app-1", displayName: "Finance Bot" } },
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "BUDGET",
      from: "finance bot",
    });

    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledWith({
      token: TOKEN,
      url: "https://graph.microsoft.com/v1.0/next-page",
    });
    expect(result).toEqual({
      messages: [
        {
          id: "right-sender",
          text: "Budget update",
          from: { application: { id: "app-1", displayName: "Finance Bot" } },
          createdAt: undefined,
        },
      ],
      truncated: false,
    });
  });

  it("matches the sender by stable ID", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content: "hello" },
          from: { user: { id: "aad-user-1", displayName: "Alice" } },
        },
      ],
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "hello",
      from: "AAD-USER-1",
    });

    expect(result.messages).toHaveLength(1);
  });

  it("stops at the requested result limit and reports remaining pages", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        { id: "msg-1", body: { content: "match" } },
        { id: "msg-2", body: { content: "match" } },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "match",
      limit: 1,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["msg-1"]);
    expect(result.truncated).toBe(true);
    expect(mockState.fetchGraphAbsoluteUrl).not.toHaveBeenCalled();
  });

  it("clamps a non-finite limit to the default", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: Array.from({ length: 30 }, (_, index) => ({
        id: `msg-${index}`,
        body: { content: "match" },
      })),
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "match",
      limit: Number.POSITIVE_INFINITY,
    });

    expect(result.messages).toHaveLength(25);
    expect(result.truncated).toBe(true);
  });

  it("reports truncation after the bounded ten-page scan", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2",
    });
    mockState.fetchGraphAbsoluteUrl.mockImplementation(async ({ url }: { url: string }) => {
      const page = Number(url.match(/page-(\d+)/)?.[1] ?? "2");
      return {
        value: [],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/page-${page + 1}`,
      };
    });

    const result = await searchMessagesMSTeams({
      cfg: {} as OpenClawConfig,
      to: CHAT_ID,
      query: "missing",
    });

    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledTimes(9);
    expect(result).toEqual({ messages: [], truncated: true });
  });
});
