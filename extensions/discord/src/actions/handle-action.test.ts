import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const discordContext = { currentChannelProvider: "discord" };
const foreignRequester = {
  requesterSenderId: "telegram-user-id",
  toolContext: { currentChannelProvider: "telegram" },
};
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

function threadAction(action: "thread-create" | "thread-reply", params: Record<string, unknown>) {
  return runAction(action, params, { cfg: discordConfig({ threads: true }), ...threadContext });
}

const cleanupRoutes: Array<() => void> = [];
function beginRoute(
  options: Partial<Parameters<typeof beginDiscordActiveTurnThreadRoute>[1]> = {},
) {
  const route = {
    ...sourceRoute,
    onThreadAdopted: vi.fn(),
    onThreadReplyDelivered: vi.fn(),
    ...options,
  };
  cleanupRoutes.push(beginDiscordActiveTurnThreadRoute(sessionKey, route));
  return route;
}
function mockResult(details: Record<string, unknown> = { ok: true }) {
  const result = { content: [], details };
  handleDiscordActionMock.mockResolvedValueOnce(result);
  return result;
}
const threadParams = {
  channelId: "channel-1",
  messageId: "message-1",
  threadName: "investigation",
};

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });
  afterEach(() => {
    for (const cleanup of cleanupRoutes.splice(0)) {
      cleanup();
    }
  });

  it.each([
    {
      action: "timeout",
      actions: { moderation: true, channels: false },
      params: { guildId: "guild-1", userId: "user-2", durationMin: 5 },
      payload: {
        action: "timeout",
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        until: undefined,
        reason: undefined,
        deleteMessageDays: undefined,
      },
    },
    {
      action: "channel-delete",
      actions: { moderation: false, channels: true },
      params: { channelId: "channel-1" },
      payload: { action: "channelDelete", channelId: "channel-1" },
    },
  ] as const)(
    "uses trusted sender identity for $action, ignoring spoofed params",
    async ({ action, actions, params, payload }) => {
      const cfg = discordConfig(actions);
      await runAction(
        action,
        { ...params, senderUserId: "spoofed-admin-id" },
        { cfg, requesterSenderId: "trusted-sender-id", toolContext: discordContext },
      );
      expectDiscordActionCall({
        payload: { ...payload, accountId: undefined, senderUserId: "trusted-sender-id" },
        cfg,
      });
    },
  );

  it("rejects fractional moderation durations before invoking Discord runtime", async () => {
    const cfg = discordConfig({ moderation: true });
    await expectRejected(
      "durationMin must be a non-negative integer",
      "timeout",
      { guildId: "guild-1", userId: "user-2", durationMin: 5.5 },
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
      { channelId: "channel-1", threadName: "proof-thread", autoArchiveMin: 999 },
      { cfg, toolContext: { currentChannelProvider: "discord" } },
    );
  });

  it.each([
    ["channel-delete", { channelId: "channel-1" }, { channels: true }],
    ["timeout", { guildId: "guild-1", userId: "user-2", durationMin: 5 }, { moderation: true }],
  ] as const)("rejects foreign requester identities for %s", async (action, params, actions) => {
    await expectRejected("trusted Discord sender identity", action, params, {
      cfg: discordConfig(actions),
      ...foreignRequester,
    });
  });

  it("keeps no-context Discord guild admin actions on the manual runtime path", async () => {
    const cfg = discordConfig({ channels: true });
    await runAction("channel-delete", { channelId: "channel-1" }, { cfg, senderIsOwner: true });

    expectDiscordActionCall({
      payload: { action: "channelDelete", accountId: undefined, channelId: "channel-1" },
      cfg,
    });
  });

  it("rejects no-context Discord guild admin actions without owner trust", async () => {
    const cfg = discordConfig({ channels: true });
    await expectRejected(
      "trusted Discord sender identity",
      "channel-delete",
      { channelId: "channel-1" },
      { cfg },
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
      await runAction(action, params, { cfg, ...foreignRequester });

      expectDiscordActionCall({
        payload: { action: runtimeAction, accountId: undefined, ...params },
        cfg,
      });
    },
  );

  it("falls back to Discord toolContext.currentChannelId for reaction targets", async () => {
    const cfg = discordConfig();
    await runAction(
      "react",
      { emoji: "ok" },
      {
        cfg,
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "user:U1",
          currentMessageId: "9001",
        },
      },
    );

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

  it("forwards attested current-conversation context to Discord channel info", async () => {
    const cfg = discordConfig({ channelInfo: true });
    await runAction(
      "channel-info",
      { channelId: "123" },
      {
        cfg,
        accountId: "ops",
        requesterAccountId: "ops",
        conversationReadOrigin: "delegated",
        toolContext: { currentChannelProvider: "discord", currentChannelId: "channel:123" },
      },
    );

    expectDiscordActionCall({
      payload: { action: "channelInfo", accountId: "ops", channelId: "123" },
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

  it.each([
    { action: "send" as const, params: { to: "channel:c1", message: "hello" } },
    { action: "upload-file" as const, params: { to: "channel:c1", filePath: "/tmp/image.png" } },
    { action: "sticker" as const, params: { to: "channel:c1", stickerId: ["sticker-1"] } },
    { action: "thread-reply" as const, params: { threadId: "c1", message: "thread update" } },
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
    const { onThreadAdopted, onThreadReplyDelivered } = beginRoute();
    expect(notifyDiscordActiveTurnThreadReplyDelivered(threadContext)).toBe(false);
    mockResult({ ok: true, thread: { id: "thread-1" } });
    await threadAction("thread-create", threadParams);
    expect(onThreadAdopted).toHaveBeenCalledWith("thread-1");
    mockResult();
    const mismatchedResult = await threadAction("thread-reply", {
      threadId: "thread-2",
      message: "unrelated",
    });
    expect(mismatchedResult.details).toEqual({ ok: true });
    expect(onThreadReplyDelivered).not.toHaveBeenCalled();
    mockResult();
    const result = await threadAction("thread-reply", { threadId: "thread-1", message: "done" });
    expect(result.details).toEqual({ ok: true, sourceReplyRoute: "current-source" });
    expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
  });

  it("confirms only the matching adopted thread across concurrent routes", async () => {
    const { onThreadReplyDelivered: firstReplyDelivered } = beginRoute();
    const { onThreadReplyDelivered: secondReplyDelivered } = beginRoute({
      sourceMessageId: "message-2",
    });
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
      notifyDiscordActiveTurnThreadReplyDelivered({ ...threadContext, threadId: "thread-2" }),
    ).toBe(true);
    expect(firstReplyDelivered).not.toHaveBeenCalled();
    expect(secondReplyDelivered).toHaveBeenCalledWith("thread-2");
  });

  it("keeps a successful thread-create result when progress migration fails", async () => {
    const onThreadAdoptionError = vi.fn();
    beginRoute({
      accountId: undefined,
      onThreadAdopted: async () => {
        throw new Error("preview move failed");
      },
      onThreadAdoptionError,
    });
    const expectedResult = mockResult({ ok: true, thread: { id: "thread-1" } });
    const result = await runAction("thread-create", threadParams, {
      cfg: discordConfig({ threads: true }),
      sessionKey,
    });
    expect(result).toBe(expectedResult);
    expect(onThreadAdoptionError).toHaveBeenCalledWith(expect.any(Error));
  });

  it.each([
    ["send", { message: "hello" }, { currentChannelId: "channel:123" }],
    ["react", { emoji: "ok" }, { currentChannelId: "user:U1", currentMessageId: "9001" }],
  ] as const)(
    "does not use another provider's current target for Discord %s",
    async (action, params, target) => {
      await expectRejected(/channel target is required/i, action, params, {
        toolContext: { currentChannelProvider: "telegram", ...target },
      });
    },
  );

  it("rejects reactions when no message id source is available", async () => {
    await expectRejected(/messageId required/i, "react", { channelId: "123", emoji: "ok" });
  });

  it("classifies generic sends only when targeting the active adopted thread", async () => {
    const { onThreadReplyDelivered } = beginRoute();
    await notifyDiscordActiveTurnThreadCreated({
      sessionKey,
      ...sourceRoute,
      threadId: "thread-1",
    });
    const unrelatedResult = await runAction(
      "send",
      { to: "channel:thread-2", message: "unrelated" },
      threadContext,
    );
    expect(unrelatedResult.details).toEqual({ ok: true });
    expect(onThreadReplyDelivered).not.toHaveBeenCalled();
    const result = await runAction(
      "send",
      { to: "channel:thread-1", message: "done" },
      threadContext,
    );
    expect(result.details).toEqual({ ok: true, sourceReplyRoute: "current-source" });
    expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
  });

  it("preserves a successful send when route-only target parsing rejects the target", async () => {
    const result = await runAction("send", { to: "@alice", message: "hello" });

    expect(result.details).toEqual({ ok: true });
  });

  it("downgrades oversized table presentations to complete text", async () => {
    const cfg = discordConfig();
    const authoredText = `${"x".repeat(1997)}AUTHORED_TAIL`;

    await runAction(
      "send",
      {
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
      { cfg },
    );

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
    expect(String(payload?.content).split("AUTHORED_TAIL")).toHaveLength(4);
    expect(payload?.content).toEqual(expect.stringContaining("LABEL_TAIL"));
  });

  it.each([
    [
      "keeps an explicitly empty message empty instead of using the caption",
      { message: "", caption: "caption text" },
      "",
    ],
    [
      "preserves caption indentation and trailing newline",
      { caption: "    example();\n" },
      "    example();\n",
    ],
    [
      "preserves an explicit padded message over the caption",
      { message: "    example();\n", caption: "caption text" },
      "    example();\n",
    ],
    [
      "preserves the content alias over the caption",
      { content: "    example();\n", caption: "caption text" },
      "    example();\n",
    ],
  ] as const)("%s", async (_name, params, expected) => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const cfg = discordConfig();
    const mediaAccess = { localRoots: ["/tmp/agent-root"], readFile: mediaReadFile };

    await runAction(
      "upload-file",
      { target: "channel:123", media: "/tmp/agent-root/chart.png", ...params },
      { cfg, mediaAccess, mediaLocalRoots: ["/tmp/agent-root"], mediaReadFile },
    );

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
