import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultActionOptions,
  discordConfig,
  expectDiscordActionCall,
  handleDiscordActionMock,
  handleDiscordMessageAction,
} from "./handle-action.test-support.js";
const {
  beginDiscordActiveTurnThreadRoute,
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} = await import("../active-turn-thread-route.js");
const { discordInboundEventDelivery } = await import("../inbound-event-delivery.js");

const sessionKey = "agent:main:discord:channel:channel-1";
const sourceRoute = {
  accountId: "account-1",
  sourceChannelId: "channel-1",
  sourceMessageId: "message-1",
};
const threadContext = { accountId: sourceRoute.accountId, sessionKey };
function runAction(
  action: Parameters<typeof handleDiscordMessageAction>[0]["action"],
  params: Record<string, unknown>,
  context: Partial<
    Omit<Parameters<typeof handleDiscordMessageAction>[0], "action" | "params">
  > = {},
) {
  return handleDiscordMessageAction({ cfg: discordConfig(), ...context, action, params });
}

async function expectRejected(error: string | RegExp, ...args: Parameters<typeof runAction>) {
  await expect(runAction(...args)).rejects.toThrow(error);
  expect(handleDiscordActionMock).not.toHaveBeenCalled();
}

function sendPayload(overrides: Record<string, unknown>) {
  return {
    action: "sendMessage",
    accountId: undefined,
    to: "channel:123",
    content: "hello",
    mediaUrl: undefined,
    filename: undefined,
    replyTo: undefined,
    components: undefined,
    embeds: undefined,
    asVoice: false,
    silent: false,
    __sessionKey: undefined,
    __agentId: undefined,
    ...overrides,
  };
}

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    const cfg = discordConfig({ moderation: true });
    await handleDiscordMessageAction({
      action: "timeout",
      params: {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
        senderUserId: "spoofed-admin-id",
      },
      cfg,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expectDiscordActionCall({
      payload: {
        action: "timeout",
        accountId: undefined,
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        until: undefined,
        reason: undefined,
        deleteMessageDays: undefined,
        senderUserId: "trusted-sender-id",
      },
      cfg,
    });
  });

  it("rejects fractional moderation durations before invoking Discord runtime", async () => {
    const cfg = discordConfig({ moderation: true });
    await expectRejected(
      "durationMin must be a non-negative integer",
      "timeout",
      {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5.5,
      },
      {
        cfg,
        requesterSenderId: "trusted-sender-id",
        toolContext: { currentChannelProvider: "discord" },
      },
    );
  });

  it("rejects invalid autoArchiveMin before Discord thread-create runtime", async () => {
    const cfg = discordConfig({ threads: true });
    await expectRejected(
      "autoArchiveMin must be one of 60, 1440, 4320, or 10080 minutes",
      "thread-create",
      {
        channelId: "channel-1",
        threadName: "proof-thread",
        autoArchiveMin: 999,
      },
      { cfg, toolContext: { currentChannelProvider: "discord" } },
    );
  });

  it("uses Discord requesterSenderId for guild admin actions and ignores params senderUserId", async () => {
    const cfg = discordConfig({ channels: true });
    await handleDiscordMessageAction({
      action: "channel-delete",
      params: {
        channelId: "channel-1",
        senderUserId: "spoofed-admin-id",
      },
      cfg,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expectDiscordActionCall({
      payload: {
        action: "channelDelete",
        accountId: undefined,
        channelId: "channel-1",
        senderUserId: "trusted-sender-id",
      },
      cfg,
    });
  });

  it("rejects non-Discord requester ids for Discord guild admin actions", async () => {
    const cfg = discordConfig({ channels: true });
    await expectRejected(
      "trusted Discord sender identity",
      "channel-delete",
      {
        channelId: "channel-1",
      },
      {
        cfg,
        requesterSenderId: "telegram-user-id",
        toolContext: { currentChannelProvider: "telegram" },
      },
    );
  });

  it("keeps no-context Discord guild admin actions on the manual runtime path", async () => {
    const cfg = discordConfig({ channels: true });
    await handleDiscordMessageAction({
      action: "channel-delete",
      params: {
        channelId: "channel-1",
      },
      cfg,
      senderIsOwner: true,
    });

    expectDiscordActionCall({
      payload: {
        action: "channelDelete",
        accountId: undefined,
        channelId: "channel-1",
      },
      cfg,
    });
  });

  it("rejects no-context Discord guild admin actions without owner trust", async () => {
    const cfg = discordConfig({ channels: true });
    await expectRejected(
      "trusted Discord sender identity",
      "channel-delete",
      {
        channelId: "channel-1",
      },
      { cfg },
    );
  });

  it("rejects non-Discord requester ids for Discord moderation actions", async () => {
    const cfg = discordConfig({ moderation: true });
    await expectRejected(
      "trusted Discord sender identity",
      "timeout",
      {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
      },
      {
        cfg,
        requesterSenderId: "telegram-user-id",
        toolContext: { currentChannelProvider: "telegram" },
      },
    );
  });

  it.each([
    ["member-info", "memberInfo", { userId: "user-1", guildId: "guild-1" }],
    ["role-info", "roleInfo", { guildId: "guild-1" }],
    ["channel-info", "channelInfo", { channelId: "channel-1" }],
    ["channel-list", "channelList", { guildId: "guild-1" }],
    ["voice-status", "voiceStatus", { guildId: "guild-1", userId: "user-1" }],
    ["event-list", "eventList", { guildId: "guild-1" }],
  ] as const)(
    "keeps %s available from non-Discord requesters",
    async (action, runtimeAction, params) => {
      const cfg = discordConfig({ channelInfo: true });
      await handleDiscordMessageAction({
        action,
        params,
        cfg,
        requesterSenderId: "telegram-user-id",
        toolContext: { currentChannelProvider: "telegram" },
      });

      expectDiscordActionCall({
        payload: { action: runtimeAction, accountId: undefined, ...params },
        cfg,
      });
    },
  );

  it("falls back to Discord toolContext.currentChannelId for reaction targets", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "react",
      params: {
        emoji: "ok",
      },
      cfg,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "user:U1",
        currentMessageId: "9001",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "react",
        accountId: undefined,
        channelId: "user:U1",
        messageId: "9001",
        emoji: "ok",
        remove: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("forwards attested current-conversation context to Discord reads", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "read",
      params: {
        channelId: "channel:123",
        messageId: "1542546825066577940",
      },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "readMessages",
        accountId: "ops",
        channelId: "123",
        limit: undefined,
        before: undefined,
        after: undefined,
        around: undefined,
        messageId: "1542546825066577940",
      },
      cfg,
      options: {
        ...defaultActionOptions(),
        conversationReadOrigin: "delegated",
        readContext: {
          requesterAccountId: "ops",
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
        },
      },
    });
  });

  it("forwards attested current-conversation context to Discord channel info", async () => {
    const cfg = discordConfig({ channelInfo: true });
    await handleDiscordMessageAction({
      action: "channel-info",
      params: {
        channelId: "123",
      },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "channelInfo",
        accountId: "ops",
        channelId: "123",
      },
      cfg,
      options: {
        conversationReadOrigin: "delegated",
        readContext: {
          requesterAccountId: "ops",
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
        },
      },
    });
  });

  it("forwards threadName on sends", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "send",
      params: {
        target: "channel:thread-1",
        message: "hello",
        threadName: "Renamed thread",
      },
      cfg,
    });

    expectDiscordActionCall({
      payload: sendPayload({ to: "channel:thread-1", threadName: "Renamed thread" }),
      cfg,
      options: defaultActionOptions(),
    });
  });

  it.each([
    {
      action: "send" as const,
      params: { to: "channel:c1", message: "hello" },
    },
    {
      action: "upload-file" as const,
      params: { to: "channel:c1", filePath: "/tmp/image.png" },
    },
    {
      action: "sticker" as const,
      params: { to: "channel:c1", stickerId: ["sticker-1"] },
    },
    {
      action: "thread-reply" as const,
      params: { threadId: "c1", message: "thread update" },
    },
    {
      action: "thread-create" as const,
      params: { channelId: "c1", messageId: "message-1", threadName: "investigation" },
    },
  ])(
    "records room-event delivery only after $action receives a positive receipt",
    async ({ action, params }) => {
      const deliverySessionKey = "agent:main:discord:channel:c1";

      for (const ok of [false, true]) {
        const markDelivered = vi.fn();
        const onThreadAdopted = vi.fn();
        const endDelivery = discordInboundEventDelivery.begin(
          deliverySessionKey,
          {
            outboundTo: "channel:c1",
            outboundAccountId: "default",
            markInboundEventDelivered: markDelivered,
          },
          { inboundEventKind: "room_event" },
        );
        const endThreadRoute =
          action === "thread-create"
            ? beginDiscordActiveTurnThreadRoute(deliverySessionKey, {
                accountId: "default",
                sourceChannelId: "c1",
                sourceMessageId: "message-1",
                onThreadAdopted,
              })
            : () => {};

        handleDiscordActionMock.mockResolvedValueOnce({
          content: [],
          details: {
            ok,
            ...(ok ? {} : { error: "delivery failed" }),
            ...(action === "thread-create" ? { thread: { id: "thread-1" } } : {}),
          },
        });

        try {
          const result = await handleDiscordMessageAction({
            action,
            params,
            cfg: discordConfig({ threads: true, polls: true, stickers: true }),
            accountId: "default",
            sessionKey: deliverySessionKey,
            inboundEventKind: "room_event",
          });

          expect(result.details).toMatchObject({ ok });
          expect(markDelivered).toHaveBeenCalledTimes(ok ? 1 : 0);
          if (action === "thread-create") {
            expect(onThreadAdopted).toHaveBeenCalledTimes(ok ? 1 : 0);
          }
        } finally {
          endThreadRoute();
          endDelivery();
        }
      }
    },
  );

  it("requires a file path for upload-file", async () => {
    await expectRejected(/upload-file requires filePath, path, or media/i, "upload-file", {
      to: "channel:123",
    });
  });

  it("rejects upload-file with a buffer and points at send", async () => {
    await expectRejected(
      'Use action: "send" for base64 buffer attachments; upload-file requires filePath, path, or media.',
      "upload-file",
      {
        to: "channel:123",
        filename: "report.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("report").toString("base64"),
      },
    );
  });

  it("adopts a thread created from the active source message and confirms replies there", async () => {
    const onThreadAdopted = vi.fn();
    const onThreadReplyDelivered = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      ...sourceRoute,
      onThreadAdopted,
      onThreadReplyDelivered,
    });
    try {
      expect(
        notifyDiscordActiveTurnThreadReplyDelivered({
          ...threadContext,
        }),
      ).toBe(false);

      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: true, thread: { id: "thread-1" } },
      });
      await handleDiscordMessageAction({
        action: "thread-create",
        params: {
          channelId: "channel-1",
          messageId: "message-1",
          threadName: "investigation",
        },
        cfg: discordConfig({ threads: true }),
        ...threadContext,
      });

      expect(onThreadAdopted).toHaveBeenCalledWith("thread-1");

      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: true },
      });
      const mismatchedResult = await handleDiscordMessageAction({
        action: "thread-reply",
        params: {
          threadId: "thread-2",
          message: "unrelated",
        },
        cfg: discordConfig({ threads: true }),
        ...threadContext,
      });

      expect(mismatchedResult.details).toEqual({ ok: true });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();

      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: true },
      });
      const result = await handleDiscordMessageAction({
        action: "thread-reply",
        params: {
          threadId: "thread-1",
          message: "done",
        },
        cfg: discordConfig({ threads: true }),
        ...threadContext,
      });

      expect(result.details).toEqual({
        ok: true,
        sourceReplyRoute: "current-source",
      });
      expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
    } finally {
      endRoute();
    }
  });

  it("confirms only the matching adopted thread across concurrent routes", async () => {
    const firstReplyDelivered = vi.fn();
    const secondReplyDelivered = vi.fn();
    const endFirstRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      ...sourceRoute,
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered: firstReplyDelivered,
    });
    const endSecondRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      ...sourceRoute,
      sourceMessageId: "message-2",
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered: secondReplyDelivered,
    });
    try {
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        ...sourceRoute,
        threadId: "thread-1",
      });
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        ...sourceRoute,
        sourceMessageId: "message-2",
        threadId: "thread-2",
      });

      expect(
        notifyDiscordActiveTurnThreadReplyDelivered({
          ...threadContext,
          threadId: "thread-2",
        }),
      ).toBe(true);
      expect(firstReplyDelivered).not.toHaveBeenCalled();
      expect(secondReplyDelivered).toHaveBeenCalledWith("thread-2");
    } finally {
      endFirstRoute();
      endSecondRoute();
    }
  });

  it("keeps a successful thread-create result when progress migration fails", async () => {
    const onThreadAdoptionError = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted: async () => {
        throw new Error("preview move failed");
      },
      onThreadAdoptionError,
    });
    try {
      const expectedResult = {
        content: [],
        details: { ok: true, thread: { id: "thread-1" } },
      };
      handleDiscordActionMock.mockResolvedValueOnce(expectedResult);

      const result = await handleDiscordMessageAction({
        action: "thread-create",
        params: {
          channelId: "channel-1",
          messageId: "message-1",
          threadName: "investigation",
        },
        cfg: discordConfig({ threads: true }),
        sessionKey,
      });

      expect(result).toBe(expectedResult);
      expect(onThreadAdoptionError).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      endRoute();
    }
  });

  it("forwards top-level components on sends", async () => {
    const components = { blocks: [{ type: "text", text: "Pick one" }] };
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "send",
      params: {
        message: "hello",
        components: JSON.stringify(components),
      },
      cfg,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: sendPayload({ components }),
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("does not use another provider's current target for Discord sends", async () => {
    await expectRejected(
      /channel target is required/i,
      "send",
      {
        message: "hello",
      },
      {
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "channel:123",
        },
      },
    );
  });

  it("does not use another provider's current target for Discord reactions", async () => {
    await expectRejected(
      /channel target is required/i,
      "react",
      {
        emoji: "ok",
      },
      {
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "user:U1",
          currentMessageId: "9001",
        },
      },
    );
  });

  it("rejects reactions when no message id source is available", async () => {
    await expectRejected(/messageId required/i, "react", {
      channelId: "123",
      emoji: "ok",
    });
  });

  it("does not inject session channel when guildId is explicit and no channel filters are provided", async () => {
    handleDiscordActionMock.mockResolvedValueOnce({ content: [], details: { ok: true } });
    await handleDiscordMessageAction({
      action: "search",
      params: {
        query: "guild-wide query",
        guildId: "g1",
      },
      cfg: discordConfig(),
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "session-ch",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    const payload = expectDefined(
      handleDiscordActionMock.mock.calls[0]?.[0],
      "Discord guild search action payload",
    );
    expect(payload).toMatchObject({
      action: "searchMessages",
      content: "guild-wide query",
      guildId: "g1",
    });
    // Guild-wide search must NOT be narrowed to the session channel.
    expect(payload.channelId).toBeUndefined();
    expect(payload.channelIds).toBeUndefined();
  });

  it("classifies generic sends only when targeting the active adopted thread", async () => {
    const onThreadReplyDelivered = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      ...sourceRoute,
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered,
    });
    try {
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        ...sourceRoute,
        threadId: "thread-1",
      });

      const unrelatedResult = await handleDiscordMessageAction({
        action: "send",
        params: {
          to: "channel:thread-2",
          message: "unrelated",
        },
        cfg: discordConfig(),
        ...threadContext,
      });

      expect(unrelatedResult.details).toEqual({ ok: true });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();

      const result = await handleDiscordMessageAction({
        action: "send",
        params: {
          to: "channel:thread-1",
          message: "done",
        },
        cfg: discordConfig(),
        ...threadContext,
      });

      expect(result.details).toEqual({
        ok: true,
        sourceReplyRoute: "current-source",
      });
      expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
    } finally {
      endRoute();
    }
  });

  it("preserves a successful send when route-only target parsing rejects the target", async () => {
    const result = await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "@alice",
        message: "hello",
      },
      cfg: discordConfig(),
    });

    expect(result.details).toEqual({ ok: true });
  });

  it("preserves trusted workspace authority for thread replies and rejects forged action capabilities", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("trusted report"));
    const mediaAccess = {
      localRoots: ["/tmp/agent-workspace"],
      readFile: mediaReadFile,
      workspaceDir: "/tmp/agent-workspace",
    };
    const forgedMediaAccess = {
      localRoots: ["/tmp/forged-root"],
      readFile: vi.fn(async () => Buffer.from("forged report")),
      workspaceDir: "/tmp/forged-root",
    };
    const cfg = discordConfig({ threads: true });

    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        threadId: "thread-123",
        message: "thread update",
        filePath: "./report.md",
        mediaAccess: forgedMediaAccess,
      },
      cfg,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      {
        action: "threadReply",
        accountId: undefined,
        channelId: "thread-123",
        content: "thread update",
        mediaUrl: "./report.md",
        replyTo: undefined,
      },
      cfg,
      { mediaAccess, mediaLocalRoots: mediaAccess.localRoots, mediaReadFile },
    );
    expect(handleDiscordActionMock.mock.calls[0]?.[1]).toBe(cfg);
    const actionOptions = handleDiscordActionMock.mock.calls[0]?.[2];
    expect(actionOptions?.mediaAccess).toBe(mediaAccess);
    expect(actionOptions?.mediaLocalRoots).toBe(mediaAccess.localRoots);
    expect(actionOptions?.mediaReadFile).toBe(mediaReadFile);
    expect(forgedMediaAccess.readFile).not.toHaveBeenCalled();
  });

  it("downgrades oversized table presentations to complete text", async () => {
    const cfg = discordConfig();
    const authoredText = `${"x".repeat(1997)}AUTHORED_TAIL`;

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        presentation: {
          title: authoredText,
          blocks: [
            { type: "text", text: authoredText },
            { type: "context", text: authoredText },
            {
              type: "buttons",
              buttons: [{ label: `${"x".repeat(80)}LABEL_TAIL`, value: "choice" }],
            },
            {
              type: "table",
              caption: "Large pipeline",
              headers: ["Account", "Stage"],
              rows: Array.from({ length: 900 }, (_entry, index) => [
                `account-${String(index)}-${"x".repeat(80)}`,
                "Review",
              ]),
            },
          ],
        },
      },
      cfg,
    });

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
    expect(String(payload?.content).split("AUTHORED_TAIL")).toHaveLength(4);
    expect(payload?.content).toEqual(expect.stringContaining("LABEL_TAIL"));
  });

  it.each([
    {
      name: "keeps an explicitly empty message empty instead of using the caption",
      params: { message: "", caption: "caption text" },
      expected: "",
    },
    {
      name: "preserves caption indentation and trailing newline",
      params: { caption: "    example();\n" },
      expected: "    example();\n",
    },
    {
      name: "preserves an explicit padded message over the caption",
      params: { message: "    example();\n", caption: "caption text" },
      expected: "    example();\n",
    },
    {
      name: "preserves the content alias over the caption",
      params: { content: "    example();\n", caption: "caption text" },
      expected: "    example();\n",
    },
  ])("$name", async ({ params, expected }) => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const cfg = discordConfig();
    const mediaAccess = { localRoots: ["/tmp/agent-root"], readFile: mediaReadFile };

    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        target: "channel:123",
        media: "/tmp/agent-root/chart.png",
        ...params,
      },
      cfg,
      mediaAccess,
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    const [call] = handleDiscordActionMock.mock.calls;
    expect(call?.[0]).toMatchObject({
      action: "sendMessage",
      to: "channel:123",
      mediaUrl: "/tmp/agent-root/chart.png",
      content: expected,
    });
    expect(call?.[1]).toBe(cfg);
    expect(call?.[2]).toEqual({
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile,
    });
  });
});
