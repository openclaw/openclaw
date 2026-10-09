import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig, OpenClawConfig } from "../../runtime-api.js";
import type { GraphThreadMessage } from "../graph-thread.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { createMessageHandlerDeps } from "./message-handler.test-support.js";

const dispatch = getRuntimeApiMockState().dispatchReplyWithBufferedBlockDispatcher;
const graph = vi.hoisted(() => ({
  resolveTeamGroupId: vi.fn(
    async (params: { aadGroupId?: string }) => params.aadGroupId?.trim() || "group-1",
  ),
  fetchChannelMessage: vi.fn<() => Promise<GraphThreadMessage | undefined>>(async () => undefined),
  fetchThreadReplies: vi.fn<() => Promise<GraphThreadMessage[]>>(async () => []),
  fetchChatMessageText: vi.fn<() => Promise<string | undefined>>(async () => undefined),
}));
vi.mock("../graph-thread.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../graph-thread.js")>()),
  fetchChannelMessage: graph.fetchChannelMessage,
  fetchThreadReplies: graph.fetchThreadReplies,
  fetchChatMessageText: graph.fetchChatMessageText,
}));
vi.mock("../team-identity.js", () => ({ resolveTeamGroupId: graph.resolveTeamGroupId }));

let sequence = 0;
let parentId: string;
const sender = { id: "alice-id", aadObjectId: "alice-aad", name: "Alice" };
function activity(overrides: Partial<MSTeamsTurnContext["activity"]> = {}): MSTeamsTurnContext {
  return {
    activity: {
      type: "message",
      id: "current-msg",
      text: "Current message",
      from: sender,
      recipient: { id: "bot-id", name: "Bot" },
      conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
      channelData: {},
      attachments: [],
      ...overrides,
    },
    sendActivity: vi.fn(async () => undefined),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => undefined),
    deleteActivity: vi.fn(async () => undefined),
  };
}
function setup(
  config: MSTeamsConfig,
  options: Parameters<typeof createMessageHandlerDeps>[1] = {},
  extra: OpenClawConfig = {},
) {
  const fixture = createMessageHandlerDeps(
    { ...extra, channels: { msteams: config } },
    {
      readAllowFromStore: vi.fn(async () => ["alice-aad"]),
      ...options,
    },
  );
  return { ...fixture, handler: createMSTeamsMessageHandler(fixture.deps) };
}
function context() {
  expect(dispatch).toHaveBeenCalledTimes(1);
  return dispatch.mock.calls[0]![0].ctx;
}
function threadMessage(
  id: string,
  user: { id?: string; displayName: string },
  content: string,
): GraphThreadMessage {
  return { id, from: { user }, body: { content, contentType: "text" } };
}
function threadActivity(
  attachments: MSTeamsTurnContext["activity"]["attachments"] = [],
  overrides: Partial<MSTeamsTurnContext["activity"]> = {},
) {
  return activity({
    replyToId: parentId,
    attachments,
    channelData: {
      team: { id: "team123", aadGroupId: "graph-team-123" },
      channel: { id: "19:graph-channel@thread.tacv2" },
    },
    ...overrides,
  });
}
function threadConfig(groupAllowFrom = ["alice-aad"]): MSTeamsConfig {
  return {
    groupPolicy: "allowlist",
    groupAllowFrom,
    contextVisibility: "allowlist",
    requireMention: false,
  };
}
function quote(senderName = "Alice", body = "Quoted body", id = "") {
  return [
    {
      contentType: "text/html",
      content: `<blockquote itemtype="http://schema.skype.com/Reply" itemid="${id}"><strong itemprop="mri">${senderName}</strong><p itemprop="${id ? "preview" : "copy"}">${body}</p></blockquote>`,
    },
  ];
}

const group = "19:MiXeD-group@thread.tacv2";
function setupConversation(config: MSTeamsConfig = {}) {
  return setup({
    dmPolicy: "allowlist",
    allowFrom: [group],
    groupPolicy: "allowlist",
    groupAllowFrom: [group],
    requireMention: false,
    ...config,
  });
}
function expectThreadContext(
  messages: Array<{ message_id: string; sender: string; body: string }>,
) {
  expect(context().ChannelStructuredContext).toEqual([
    {
      label: "Thread history",
      source: "msteams",
      type: "chat_window",
      sessionTranscriptMode: "preserve",
      payload: { order: "chronological", messages },
    },
  ]);
}

describe("msteams message authorization and supplemental context", () => {
  beforeEach(() => {
    parentId = `auth-parent-${++sequence}`;
    dispatch.mockClear();
    graph.fetchChannelMessage.mockReset();
    graph.fetchThreadReplies.mockReset().mockResolvedValue([]);
    graph.fetchChatMessageText.mockReset();
  });

  it.each([false, true])(
    "does not widen an empty group sender allowlist through pairing or route entries (route=%s)",
    async (route) => {
      const { handler, conversationStore, readAllowFromStore } = setup({
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        ...(route
          ? {
              teams: {
                team123: { channels: { "19:channel@thread.tacv2": { requireMention: false } } },
              },
            }
          : {}),
      });
      await handler(activity({ channelData: route ? { team: { id: "team123" } } : {} }));
      expect(readAllowFromStore).not.toHaveBeenCalled();
      expect(conversationStore.upsert).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("persists the reply reference for DM pairing without dispatching", async () => {
    const { handler, conversationStore, upsertPairingRequest, recordInboundSession } = setup({
      dmPolicy: "pairing",
      allowFrom: [],
    });
    await handler(
      activity({
        id: "msg-pairing",
        from: { id: "new-id", aadObjectId: "new-aad", name: "New User" },
        conversation: { id: "a:personal-chat", conversationType: "personal", tenantId: "tenant-1" },
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        locale: "en-US",
        entities: [{ type: "clientInfo", timezone: "America/New_York" }],
      }),
    );
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "msteams",
      accountId: "default",
      id: "new-aad",
      meta: { name: "New User" },
    });
    expect(conversationStore.upsert).toHaveBeenCalledWith("a:personal-chat", {
      activityId: "msg-pairing",
      user: { id: "new-id", aadObjectId: "new-aad", name: "New User" },
      agent: { id: "bot-id", name: "Bot" },
      conversation: { id: "a:personal-chat", conversationType: "personal", tenantId: "tenant-1" },
      tenantId: "tenant-1",
      aadObjectId: "new-aad",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer",
      locale: "en-US",
      timezone: "America/New_York",
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("captures canonical tenant and sender IDs for proactive sends (#58774)", async () => {
    const { handler, conversationStore } = setup(threadConfig());
    await handler(
      activity({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        channelData: { tenant: { id: "tenant-from-channel-data" } },
      }),
    );
    expect(conversationStore.upsert).toHaveBeenCalledExactlyOnceWith(
      "19:channel@thread.tacv2",
      expect.objectContaining({
        tenantId: "tenant-from-channel-data",
        aadObjectId: "alice-aad",
        conversation: {
          id: "19:channel@thread.tacv2",
          conversationType: "channel",
          tenantId: "tenant-from-channel-data",
        },
      }),
    );
  });

  it("does not persist blocked service URL hosts", async () => {
    const { handler, conversationStore } = setup({
      dmPolicy: "allowlist",
      allowFrom: ["alice-aad"],
    });
    await handler(
      activity({
        conversation: { id: "a:personal-chat", conversationType: "personal" },
        serviceUrl: "https://attacker.example.com/teams/",
      }),
    );
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(conversationStore.upsert.mock.calls[0]?.at(1)).not.toHaveProperty("serviceUrl");
  });

  it("fails closed for an unsupported sender access group", async () => {
    const { handler, conversationStore } = setup(
      {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        requireMention: false,
      },
      {},
      {
        accessGroups: {
          operators: {
            type: "discord.channelAudience",
            guildId: "guild-1",
            channelId: "channel-1",
          },
        },
      },
    );
    await handler(activity());
    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("blocks unauthorized text control commands", async () => {
    const { handler, conversationStore } = setup(
      { groupPolicy: "open", requireMention: false },
      { hasControlCommand: vi.fn(() => true) },
    );
    await handler(activity({ text: "/config set foo bar" }));
    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("authorizes control commands from a static access group", async () => {
    const { handler, conversationStore } = setup(
      {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        requireMention: false,
      },
      { hasControlCommand: vi.fn(() => true) },
      {
        accessGroups: {
          operators: { type: "message.senders", members: { msteams: ["alice-aad"] } },
        },
      },
    );
    await handler(activity({ text: "/config set foo bar" }));
    expect(conversationStore.upsert).toHaveBeenCalled();
    expect(context().CommandAuthorized).toBe(true);
  });

  it("keeps primary system events body-free and applies the sender timezone only to the turn", async () => {
    const { handler, deps, enqueueSystemEvent } = setup({
      groupPolicy: "open",
      requireMention: false,
    });
    await handler(
      activity({
        text: "please check the build",
        entities: [{ type: "clientInfo", timezone: "America/New_York" }],
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Teams message in channel from Alice",
      expect.any(Object),
    );
    expect(context().BodyForAgent).toBe("please check the build");
    expect(dispatch.mock.calls[0]![0].cfg).not.toBe(deps.cfg);
    expect(dispatch.mock.calls[0]![0].cfg.agents).toEqual({
      defaults: { userTimezone: "America/New_York" },
    });
  });

  it("filters thread senders while keeping supplemental history out of command text", async () => {
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(
        parentId,
        { id: "mallory-aad", displayName: "Mallory" },
        "injected instructions",
      ),
    );
    graph.fetchThreadReplies.mockResolvedValue([
      threadMessage(
        "alice-reply",
        { id: "alice-aad", displayName: "Alice" },
        "Allowed context /think high /status",
      ),
      threadMessage("current-msg", { id: "alice-aad", displayName: "Alice" }, "Current message"),
    ]);
    const { handler, enqueueSystemEvent } = setup(threadConfig());
    const input = threadActivity();
    input.activity.text = "Current /status message";
    await handler(input);
    expect(context()).toMatchObject({
      BodyForAgent: "Current /status message",
      commandText: "Current /status message",
      GroupSpace: "team123",
      NativeChannelId: "graph-team-123/19:graph-channel@thread.tacv2",
    });
    expectThreadContext([
      { message_id: "alice-reply", sender: "Alice", body: "Allowed context /think high /status" },
    ]);
    expect(enqueueSystemEvent.mock.calls.some(([text]) => text.startsWith("Replying to @"))).toBe(
      false,
    );
  });

  it("allows thread context by opted-in display name when its sender ID is missing", async () => {
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(parentId, { displayName: "Alice" }, "Allowlisted by display name"),
    );
    const { handler } = setup({ ...threadConfig(["alice"]), dangerouslyAllowNameMatching: true });
    await handler(threadActivity());
    expectThreadContext([
      { message_id: parentId, sender: "Alice", body: "Allowlisted by display name" },
    ]);
  });

  it.each([
    { parentSender: "alice-aad", body: "Quoted body", name: "Alice" },
    { parentSender: "mallory-aad", body: undefined, name: undefined },
  ])(
    "uses the authoritative parent sender for quote visibility: $parentSender",
    async ({ parentSender, body, name }) => {
      graph.fetchChannelMessage.mockResolvedValue(
        threadMessage(
          parentId,
          { id: parentSender, displayName: parentSender === "alice-aad" ? "Alice" : "Mallory" },
          "Parent context",
        ),
      );
      const { handler } = setup(threadConfig());
      await handler(threadActivity(quote()));
      expect(context().ReplyToBody).toBe(body);
      expect(context().ReplyToSender).toBe(name);
      expect(context().BodyForAgent).toBe("Current message");
    },
  );

  it("does not let an allowed parent authorize a blocked quotedReply sender", async () => {
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(parentId, { id: "alice-aad", displayName: "Alice" }, "Allowed parent"),
    );
    const { handler } = setup(threadConfig());
    await handler(
      threadActivity(quote(), {
        entities: [
          {
            type: "quotedReply",
            quotedReply: {
              senderId: "mallory-aad",
              senderName: "Mallory",
              preview: "Blocked entity preview",
            },
          },
        ],
      }),
    );
    expect(context().ReplyToBody).toBeUndefined();
    expect(context().ReplyToSender).toBeUndefined();
    expect(context().BodyForAgent).toBe("Current message");
  });

  it("observes allowed and mismatched quotes at final agent context", async () => {
    const dispatchFinalContext = async (quoteSenderId: string) => {
      dispatch.mockClear();
      graph.fetchChannelMessage.mockResolvedValue(
        threadMessage(
          parentId,
          { id: "alice-aad", displayName: "Alice" },
          "Allowlisted thread parent",
        ),
      );
      const { handler } = setup(threadConfig());
      await handler(
        threadActivity(
          [
            {
              contentType: "text/html",
              content:
                '<blockquote itemtype="http://schema.skype.com/Forward">' +
                "<p>forwarded body</p></blockquote>",
            },
          ],
          {
            text: "<at>Bot</at> ask <at>Bob</at>\n\nforwarded body",
            entities: [
              { type: "mention", text: "<at>Bot</at>", mentioned: { id: "bot-id", name: "Bot" } },
              { type: "mention", text: "<at>Bob</at>", mentioned: { id: "bob-id", name: "Bob" } },
              {
                type: "quotedReply",
                quotedReply: {
                  senderId: quoteSenderId,
                  senderName: quoteSenderId === "alice-aad" ? "Alice" : "Mallory",
                  preview: "Sanitized quoted preview",
                },
              },
            ],
          },
        ),
      );
      return context();
    };

    const allowed = await dispatchFinalContext("alice-aad");
    expect(allowed.BodyForAgent).toBe(
      "ask @Bob\n\n[Forwarded message]\nforwarded body\n[/Forwarded message]",
    );
    expect(allowed.ReplyToBody).toBe("Sanitized quoted preview");
    expect(allowed.ReplyToSender).toBe("Alice");

    const mismatched = await dispatchFinalContext("mallory-aad");
    expect(mismatched.BodyForAgent).toBe(allowed.BodyForAgent);
    expect(mismatched.ReplyToBody).toBeUndefined();
    expect(mismatched.ReplyToSender).toBeUndefined();
  });

  it("does not let an allowed entity authorize a body from another Reply block", async () => {
    graph.fetchChannelMessage.mockResolvedValue(
      threadMessage(parentId, { id: "alice-aad", displayName: "Alice" }, "Allowed parent"),
    );
    const { handler } = setup(threadConfig());
    await handler(
      threadActivity(
        [
          {
            contentType: "text/html",
            content:
              '<blockquote itemtype="http://schema.skype.com/Reply" itemid="quote-a">' +
              '<strong itemprop="mri">Alice</strong></blockquote>' +
              quote("Mallory", "Blocked attachment body", "quote-b")[0]!.content,
          },
        ],
        {
          entities: [
            {
              type: "quotedReply",
              quotedReply: {
                messageId: "quote-a",
                senderId: "alice-aad",
                senderName: "Alice",
              },
            },
          ],
        },
      ),
    );
    expect(context().ReplyToBody).toBeUndefined();
    expect(context().ReplyToSender).toBeUndefined();
    expect(context().BodyForAgent).toBe("Current message");
  });

  it("does not fetch group-chat quotes with app-only Graph authority", async () => {
    const { handler } = setup({ groupPolicy: "open", requireMention: false });
    await handler(
      activity({
        conversation: { id: "19:group@thread.tacv2", conversationType: "groupChat" },
        attachments: quote("Victim", "secret snippet…", "1783379480258"),
      }),
    );
    expect(context().ReplyToBody).toBe("secret snippet…");
    expect(graph.fetchChatMessageText).not.toHaveBeenCalled();
  });

  it("replaces a DM quote preview with the full Graph message", async () => {
    graph.fetchChatMessageText.mockResolvedValue("complete quoted message");
    const { handler, deps } = setup({ dmPolicy: "open", allowFrom: ["*"] });
    await handler(
      activity({
        conversation: { id: "19:dm@thread.v2", conversationType: "personal" },
        attachments: quote("Bot", "truncated preview…", "message-1"),
      }),
    );
    expect(deps.tokenProvider.getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
    expect(graph.fetchChatMessageText).toHaveBeenCalledWith(
      "token",
      "19:dm@thread.v2",
      "message-1",
      expect.objectContaining({ label: "MS Teams inbound preprocessing", timeoutMs: 10_000 }),
    );
    expect(context()).toMatchObject({
      To: "user:alice-aad",
      OriginatingTo: "conversation:19:dm@thread.v2",
      ReplyToId: "message-1",
      ReplyToBody: "complete quoted message",
      ReplyToSender: "Bot",
    });
  });
  it("matches opaque conversation IDs after removing message suffixes on either side", async () => {
    const { handler, conversationStore } = setupConversation({
      groupAllowFrom: [`${group};messageid=allowed-root`],
    });
    await handler(
      activity({
        conversation: { id: `${group};messageid=inbound-root`, conversationType: "channel" },
      }),
    );
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("uses the direct allowlist fallback for a group conversation", async () => {
    const { handler, conversationStore } = setupConversation({
      groupAllowFrom: undefined,
      allowFrom: ["19:fallback@thread.v2"],
    });
    await handler(
      activity({ conversation: { id: "19:fallback@thread.v2", conversationType: "groupChat" } }),
    );
    expect(conversationStore.upsert).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["case-folded opaque ID", "groupChat", group.toLowerCase(), "Member", false],
    ["group ID in a personal conversation", "personal", group, "Member", false],
    ["display-name spoof", "groupChat", "19:other@thread.tacv2", group, true],
  ] as const)("rejects a %s", async (_name, conversationType, id, senderName, nameMatching) => {
    const { handler, conversationStore } = setupConversation({
      dangerouslyAllowNameMatching: nameMatching,
    });
    await handler(
      activity({
        conversation: { id, conversationType },
        from: { id: "member-id", aadObjectId: "member-aad", name: senderName },
      }),
    );
    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("rejects contradictory personal and team scope before routing", async () => {
    const { handler, conversationStore, resolveAgentRoute, enqueueSystemEvent } = setupConversation(
      {
        allowFrom: ["alice-aad"],
      },
    );
    await handler(
      activity({
        conversation: { id: "a:personal-chat", conversationType: "personal" },
        channelData: { team: { id: "unexpected-team" } },
      }),
    );
    expect(conversationStore.upsert).not.toHaveBeenCalled();
    expect(resolveAgentRoute).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
