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
import type { GraphThreadMessage } from "./graph-thread.js";

const mockState = getGraphMessagesMockState();
installGraphMessagesMockDefaults();
let graph: GraphMessagesTestModule;
const target = { cfg: {}, to: CHAT_ID, messageId: "msg-1" };
const chatPath = `/chats/${encodeURIComponent(CHAT_ID)}`;
const graphRequest = (path: string, fields: object = {}) => ({ token: TOKEN, path, ...fields });

const NAMED_ACCOUNT_CFG: OpenClawConfig = {
  channels: { msteams: { accounts: { secondary: { appId: "secondary-app-id" } } } },
};

beforeAll(async () => {
  graph = await loadGraphMessagesTestModule();
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
    });

    await graph.getMessageMSTeams({
      cfg: NAMED_ACCOUNT_CFG,
      accountId: "secondary",
      to: "user:aad-id",
      messageId: "msg-1",
    });

    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/chats/${encodeURIComponent("19:resolved-chat@thread.tacv2")}/messages/msg-1`,
    });
    expect(mockState.resolveGraphToken).toHaveBeenCalledWith(NAMED_ACCOUNT_CFG, {
      accountId: "secondary",
    });
  });

  it.each([
    ["unknown-user", null, "No conversation found for user:unknown-user"],
    ["some-user", { conversationId: "a:bot-framework-dm-id", reference: {} }, "Bot Framework ID"],
  ] as const)("rejects unusable user target %s", async (user, conversation, error) => {
    mockState.findPreferredDmByUserId.mockResolvedValue(conversation);
    await expect(graph.getMessageMSTeams({ ...target, to: `user:${user}` })).rejects.toThrow(error);
  });
});

describe("listPinsMSTeams", () => {
  it("maps pins collected by the shared Graph paginator", async () => {
    mockState.fetchAllGraphPages.mockResolvedValue({
      items: [
        { id: "pinned-1", message: { id: "msg-1", body: { content: "First page" } } },
        { id: "pinned-2", message: { id: "msg-2", body: { content: "Second page" } } },
      ],
      truncated: false,
    });

    const result = await graph.listPinsMSTeams(target);

    expect(result.pins).toEqual([
      { id: "pinned-1", pinnedMessageId: "pinned-1", messageId: "msg-1", text: "First page" },
      { id: "pinned-2", pinnedMessageId: "pinned-2", messageId: "msg-2", text: "Second page" },
    ]);
    expect(mockState.fetchAllGraphPages).toHaveBeenCalledWith(
      graphRequest(`${chatPath}/pinnedMessages?$expand=message`, { maxPages: 10 }),
    );
  });

  it("throws for channel list-pins (not supported on Graph v1.0)", async () => {
    await expect(graph.listPinsMSTeams({ ...target, to: CHANNEL_TO })).rejects.toThrow(
      "not supported for channels",
    );
  });
});

it("counts missing and application identities without treating them as users", async () => {
  mockState.fetchGraphJson.mockResolvedValue({
    reactions: [
      { reactionType: "like", user: { user: { id: "u1", displayName: "Alice" } } },
      { reactionType: "like", user: { user: { displayName: "Deleted User" } } },
      { reactionType: "like", user: { application: { id: "app-1", displayName: "Bot" } } },
      { reactionType: "like", user: null },
      { reactionType: "like", user: { user: null } },
      { reactionType: "like" },
      { reactionType: "like", user: { user: { id: "u3", displayName: null } } },
      { reactionType: "heart", user: { user: { id: "u2", displayName: "Bob" } } },
    ],
  });

  const result = await graph.listReactionsMSTeams(target);

  expect(result.reactions).toEqual([
    {
      reactionType: "like",
      name: "like",
      emoji: "\u{1F44D}",
      count: 7,
      users: [
        { id: "u1", displayName: "Alice" },
        { id: "u3", displayName: undefined },
      ],
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

it("rejects empty reaction types", async () => {
  await expect(graph.reactMessageMSTeams({ ...target, reactionType: "   " })).rejects.toThrow(
    /Reaction type is required/,
  );
});

it("pins a message in a chat via message@odata.bind body", async () => {
  mockState.mutateGraphJson.mockResolvedValue({ id: "pinned-1" });

  const result = await graph.pinMessageMSTeams(target);

  expect(result).toEqual({ ok: true, pinnedMessageId: "pinned-1" });
  expect(mockState.mutateGraphJson).toHaveBeenCalledWith(
    graphRequest(`${chatPath}/pinnedMessages`, {
      method: "POST",
      body: {
        "message@odata.bind": `https://graph.microsoft.com/v1.0${chatPath}/messages/msg-1`,
      },
    }),
  );
});

describe("unpinMessageMSTeams", () => {
  it("unpins a message from a chat", async () => {
    mockState.deleteGraphRequest.mockResolvedValue(undefined);

    const result = await graph.unpinMessageMSTeams({ ...target, pinnedMessageId: "pinned-1" });

    expect(result).toEqual({ ok: true });
    expect(mockState.deleteGraphRequest).toHaveBeenCalledWith(
      graphRequest(`${chatPath}/pinnedMessages/pinned-1`),
    );
  });

  it("rejects unpinning a message from a channel on Graph v1.0", async () => {
    await expect(
      graph.unpinMessageMSTeams({ ...target, to: CHANNEL_TO, pinnedMessageId: "pinned-2" }),
    ).rejects.toThrow(/Pin\/unpin is not supported for channel messages/);
    expect(mockState.deleteGraphRequest).not.toHaveBeenCalled();
  });
});

describe("MSTeams reactions", () => {
  const channelPath = "/teams/team-id-1/channels/channel-id-1";
  it.each([
    ["react", "root-1", `${channelPath}/messages/root-1/replies/msg-1`, "setReaction"],
    ["unreact", "msg-1", `${channelPath}/messages/msg-1`, "unsetReaction"],
  ] as const)(
    "%s addresses %s with its reaction operation",
    async (operation, threadRootId, messagePath, action) => {
      mockState.mutateGraphJson.mockResolvedValue(undefined);
      const invoke =
        operation === "react" ? graph.reactMessageMSTeams : graph.unreactMessageMSTeams;
      await expect(
        invoke({ ...target, to: CHANNEL_TO, threadRootId, reactionType: "🎉" }),
      ).resolves.toEqual({ ok: true });
      expect(mockState.resolveGraphToken).toHaveBeenCalledWith(
        {},
        { preferDelegated: true, accountId: undefined },
      );
      expect(mockState.mutateGraphJson).toHaveBeenCalledWith(
        graphRequest(`${messagePath}/${action}`, {
          method: "POST",
          body: { reactionType: "🎉" },
          beta: true,
        }),
      );
    },
  );

  it("reads a channel reply and its reactions beneath the thread root", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ id: "msg-1" });
    const replyTarget = { ...target, to: CHANNEL_TO, threadRootId: "root-1" };

    await graph.getMessageMSTeams(replyTarget);
    expect((await graph.listReactionsMSTeams(replyTarget)).reactions).toStrictEqual([]);

    expect(mockState.fetchGraphJson.mock.calls.map(([request]) => request.path)).toEqual([
      "/teams/team-id-1/channels/channel-id-1/messages/root-1/replies/msg-1",
      "/teams/team-id-1/channels/channel-id-1/messages/root-1/replies/msg-1",
    ]);
  });
});

function searchMessage(
  id: string,
  content: string,
  from?: GraphThreadMessage["from"],
  contentType?: string,
) {
  return {
    id,
    body: { content, ...(contentType ? { contentType } : {}) },
    ...(from ? { from } : {}),
  };
}

function expectReadPath(path: string) {
  expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(1, graphRequest(path));
}

describe("searchMessagesMSTeams", () => {
  it("filters chat messages locally and normalizes HTML content", async () => {
    const content = "<p>Meeting <b>notes</b> from Monday</p>";
    const from = { user: { id: "u1", displayName: "Alice" } };
    const createdAt = "2026-03-25T10:00:00Z";
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "msg-1",
          body: { content, contentType: "html" },
          from,
          createdDateTime: createdAt,
        },
        searchMessage("msg-2", "Unrelated update", undefined, "text"),
      ],
    });

    const result = await graph.searchMessagesMSTeams({ ...target, query: "meeting notes" });

    expect(result).toEqual({
      messages: [
        {
          id: "msg-1",
          text: content,
          from: { user: { id: "u1", displayName: "Alice" } },
          createdAt,
        },
      ],
      truncated: false,
    });
    expectReadPath(`${chatPath}/messages?$top=50`);
  });

  it("keeps channel search scoped to the selected channel", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [searchMessage("msg-2", "Sprint review")],
    });

    const result = await graph.searchMessagesMSTeams({
      ...target,
      to: CHANNEL_TO,
      query: "sprint",
    });

    expect(result.messages).toHaveLength(1);
    expectReadPath("/teams/team-id-1/channels/channel-id-1/messages?$top=50");
  });

  it("follows target-scoped pagination and applies sender matching locally", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        searchMessage("wrong-sender", "budget update", { user: { id: "u1", displayName: "Bob" } }),
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
    });
    mockState.fetchGraphAbsoluteUrl.mockResolvedValue({
      value: [
        searchMessage("right-sender", "Budget update", {
          application: { id: "app-1", displayName: "Finance Bot" },
        }),
      ],
    });

    const result = await graph.searchMessagesMSTeams({
      ...target,
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

  it("clamps a non-finite limit to the default", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: Array.from({ length: 30 }, (_, index) => searchMessage(`msg-${index}`, "match")),
    });

    const result = await graph.searchMessagesMSTeams({
      ...target,
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

    const result = await graph.searchMessagesMSTeams({ ...target, query: "missing" });

    expect(mockState.fetchGraphAbsoluteUrl).toHaveBeenCalledTimes(9);
    expect(result).toEqual({ messages: [], truncated: true });
  });
});
