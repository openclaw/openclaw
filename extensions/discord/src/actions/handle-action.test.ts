import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discordConfig,
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
const adminCases = [
  ["timeout", { guildId: "guild-1", userId: "user-2", durationMin: 5 }],
  ["channel-delete", { channelId: "channel-1" }],
] as const;
type ActionContext = Parameters<typeof handleDiscordMessageAction>[0];
function runAction(
  action: ActionContext["action"],
  params: Record<string, unknown>,
  context: Partial<Omit<ActionContext, "action" | "params">> = {},
) {
  return handleDiscordMessageAction({ cfg: discordConfig(), ...context, action, params });
}

async function expectPayload(
  payload: Record<string, unknown>,
  ...args: Parameters<typeof runAction>
) {
  await runAction(...args);
  expect(handleDiscordActionMock.mock.calls[0]?.[0]).toMatchObject(payload);
}

async function expectRejected(error: string | RegExp, ...args: Parameters<typeof runAction>) {
  await expect(runAction(...args)).rejects.toThrow(error);
  expect(handleDiscordActionMock).not.toHaveBeenCalled();
}

function threadAction(action: "thread-create" | "thread-reply", params: Record<string, unknown>) {
  return runAction(action, params, { cfg: discordConfig({ threads: true }), ...threadContext });
}

const cleanupRoutes: Array<() => void> = [];
function cleanup() {
  for (const end of cleanupRoutes.splice(0)) {
    end();
  }
}
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
  autoArchiveMin: 60,
};

describe("handleDiscordMessageAction", () => {
  beforeEach(() => handleDiscordActionMock.mockClear());
  afterEach(cleanup);

  it.each(adminCases)(
    "uses trusted sender identity for %s, ignoring spoofed params",
    async (action, params) => {
      await expectPayload(
        {
          senderUserId: "trusted-sender-id",
          ...(action === "timeout" ? { durationMinutes: 5 } : {}),
        },
        action,
        { ...params, senderUserId: "spoofed-admin-id" },
        {
          cfg: discordConfig({ moderation: true, channels: true }),
          requesterSenderId: "trusted-sender-id",
          toolContext: discordContext,
        },
      );
    },
  );

  it.each(adminCases)("rejects foreign requester identities for %s", async (action, params) => {
    await expectRejected("trusted Discord sender identity", action, params, {
      cfg: discordConfig({ channels: true, moderation: true }),
      ...foreignRequester,
    });
  });

  it.each([true, undefined])(
    "requires owner trust for a no-context admin action: %s",
    async (senderIsOwner) => {
      const args = [
        "channel-delete",
        { channelId: "channel-1" },
        { cfg: discordConfig({ channels: true }), senderIsOwner },
      ] as const;
      if (!senderIsOwner) {
        await expectRejected("trusted Discord sender identity", ...args);
        return;
      }
      await expectPayload({ action: "channelDelete" }, ...args);
      expect(handleDiscordActionMock.mock.calls[0]?.[0]).not.toHaveProperty("senderUserId");
    },
  );

  it("keeps guild metadata reads available from non-Discord requesters", async () => {
    await expectPayload(
      { action: "memberInfo", guildId: "guild-1", userId: "user-1" },
      "member-info",
      { guildId: "guild-1", userId: "user-1" },
      { ...foreignRequester },
    );
  });

  it("falls back to Discord toolContext.currentChannelId for reaction targets", async () => {
    await expectPayload(
      { channelId: "user:U1", messageId: "9001", emoji: "ok" },
      "react",
      { emoji: "ok" },
      {
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "user:U1",
          currentMessageId: "9001",
        },
      },
    );
  });

  const deliveries = [
    ["send", { to: "channel:channel-1", message: "hello" }],
    ["upload-file", { to: "channel:channel-1", filePath: "/tmp/image.png" }],
    ["sticker", { to: "channel:channel-1", stickerId: ["sticker-1"] }],
    ["thread-reply", { threadId: "channel-1", message: "thread update" }],
    ["thread-create", threadParams],
  ] as const;
  it.each(
    deliveries.flatMap(([action, params]) => [false, true].map((ok) => ({ action, params, ok }))),
  )(
    "records $action room-event delivery only for a positive receipt (ok=$ok)",
    async ({ action, params, ok }) => {
      const markDelivered = vi.fn();
      cleanupRoutes.push(
        discordInboundEventDelivery.begin(
          sessionKey,
          {
            outboundTo: "channel:channel-1",
            outboundAccountId: "default",
            markInboundEventDelivered: markDelivered,
          },
          { inboundEventKind: "room_event" },
        ),
      );
      const route = action === "thread-create" ? beginRoute({ accountId: "default" }) : undefined;
      mockResult({
        ok,
        ...(action === "thread-create" ? { thread: { id: "thread-1" } } : {}),
      });

      await handleDiscordMessageAction({
        action,
        params,
        cfg: discordConfig({ threads: true, polls: true, stickers: true }),
        accountId: "default",
        sessionKey,
        inboundEventKind: "room_event",
      });

      expect(markDelivered).toHaveBeenCalledTimes(ok ? 1 : 0);
      if (route) {
        expect(route.onThreadAdopted).toHaveBeenCalledTimes(ok ? 1 : 0);
      }
    },
  );

  it.each([
    [{}, /upload-file requires filePath, path, or media/i],
    [
      {
        filename: "report.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("report").toString("base64"),
      },
      'Use action: "send" for base64 buffer attachments; upload-file requires filePath, path, or media.',
    ],
  ] as const)("rejects upload-file without a file source: %j", async (params, error) => {
    await expectRejected(error, "upload-file", { to: "channel:123", ...params });
  });

  it.each(["thread-reply", "send"] as const)(
    "classifies %s only in the active adopted thread",
    async (action) => {
      const { onThreadAdopted, onThreadReplyDelivered } = beginRoute();
      expect(notifyDiscordActiveTurnThreadReplyDelivered(threadContext)).toBe(false);
      mockResult({ ok: true, thread: { id: "thread-1" } });
      await threadAction("thread-create", threadParams);
      expect(handleDiscordActionMock.mock.calls[0]?.[0]).toMatchObject({ autoArchiveMinutes: 60 });
      expect(onThreadAdopted).toHaveBeenCalledWith("thread-1");
      const deliver = (threadId: string, message: string) =>
        action === "send"
          ? runAction("send", { to: `channel:${threadId}`, message }, threadContext)
          : threadAction(action, { threadId, message });
      const mismatchedResult = await deliver("thread-2", "unrelated");
      expect(mismatchedResult.details).toEqual({ ok: true });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();
      const result = await deliver("thread-1", "done");
      expect(result.details).toEqual({ ok: true, sourceReplyRoute: "current-source" });
      expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
    },
  );

  it("confirms only the matching adopted thread across concurrent routes", async () => {
    const { onThreadReplyDelivered: firstReplyDelivered } = beginRoute();
    const { onThreadReplyDelivered: secondReplyDelivered } = beginRoute({
      sourceMessageId: "message-2",
    });
    const adopt = (threadId: string, sourceMessageId: string) =>
      notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        ...sourceRoute,
        sourceMessageId,
        threadId,
      });
    await adopt("thread-1", "message-1");
    await adopt("thread-2", "message-2");
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

  it("preserves a successful send when route-only target parsing rejects the target", async () => {
    const result = await runAction("send", { to: "@alice", message: "hello" });

    expect(result.details).toEqual({ ok: true });
  });

  it("downgrades oversized table presentations to complete text", async () => {
    const authoredText = `${"x".repeat(1997)}AUTHORED_TAIL`;

    await runAction("send", {
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
              `account-${index}-${"x".repeat(80)}`,
              "Review",
            ]),
          },
        ],
      },
    });

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
    expect(String(payload?.content).split("AUTHORED_TAIL")).toHaveLength(4);
    expect(payload?.content).toEqual(expect.stringContaining("LABEL_TAIL"));
  });

  const paddedCaption = "    example();\n";
  it.each([
    [{ message: "", caption: "caption text" }, ""],
    [{ caption: paddedCaption }, paddedCaption],
    [{ message: paddedCaption, caption: "caption text" }, paddedCaption],
    [{ content: paddedCaption, caption: "caption text" }, paddedCaption],
  ] as const)(
    "preserves upload-file caption precedence and whitespace: %j",
    async (params, expected) => {
      await expectPayload(
        { content: expected, mediaUrl: "/tmp/agent-root/chart.png" },
        "upload-file",
        { target: "channel:123", media: "/tmp/agent-root/chart.png", ...params },
      );
    },
  );
});
