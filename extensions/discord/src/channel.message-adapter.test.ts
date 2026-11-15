import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { beforeAll, expect, it } from "vitest";
import { DiscordError } from "./internal/rest-errors.js";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";
import { sendMessageDiscord } from "./send.outbound.js";
import { makeDiscordRest, requestBody } from "./send.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordPlugin: typeof import("./channel.js").discordPlugin;

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
});

it("backs declared durable-final capabilities with outbound send proofs", async () => {
  const adapter = discordPlugin.message;
  if (!adapter) {
    throw new Error("Expected discord plugin to expose a channel message adapter");
  }
  const {
    text: sendText,
    media: sendMedia,
    payload: sendPayload,
    poll: sendPoll,
  } = adapter.send ?? {};
  if (!sendText || !sendMedia || !sendPayload || !sendPoll) {
    throw new Error("Expected Discord text, media, payload, and poll senders");
  }
  const target = { cfg: {}, to: "channel:123456", accountId: "default" };
  const { sendMessageDiscordMock: sendMessage, sendPollDiscordMock: sendPollMock } = hoisted;
  const sendOptions = {
    verbose: false,
    reply: undefined,
    accountId: "default",
    silent: undefined,
    cfg: target.cfg,
    textLimit: undefined,
    maxLinesPerMessage: undefined,
    tableMode: undefined,
    chunkMode: undefined,
  };

  const proveText = async () => {
    resetDiscordOutboundMocks(hoisted);
    const result = await sendText({ ...target, text: "hello" });
    expect(sendMessage).toHaveBeenLastCalledWith(target.to, "hello", sendOptions);
    expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    expect(result.receipt.parts[0]?.kind).toBe("text");
  };

  const proveMedia = async () => {
    resetDiscordOutboundMocks(hoisted);
    const result = await sendMedia({
      ...target,
      text: "caption",
      mediaUrl: "https://example.com/a.png",
    });
    expect(sendMessage).toHaveBeenLastCalledWith("channel:123456", "caption", {
      ...sendOptions,
      mediaUrl: "https://example.com/a.png",
      mediaAccess: undefined,
      mediaLocalRoots: undefined,
      mediaReadFile: undefined,
    });
    expect(result.receipt.parts[0]?.kind).toBe("media");
  };

  const provePayload = async () => {
    resetDiscordOutboundMocks(hoisted);
    const result = await sendPayload({
      ...target,
      text: "payload",
      payload: { text: "payload" },
    });
    expect(sendMessage).toHaveBeenLastCalledWith(
      "channel:123456",
      "payload",
      expect.objectContaining({
        ...sendOptions,
        onDeliveryResult: expect.any(Function),
      }),
    );
    expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
  };

  const provePoll = async () => {
    resetDiscordOutboundMocks(hoisted);
    const result = await sendPoll({
      ...target,
      poll: { question: "Ship?", options: ["Yes", "No"] },
      silent: true,
    });
    expect(sendPollMock).toHaveBeenLastCalledWith(
      "channel:123456",
      { question: "Ship?", options: ["Yes", "No"] },
      { accountId: "default", silent: true, cfg: {} },
    );
    expect(result.receipt.parts[0]?.kind).toBe("poll");
  };

  const proveReplyThreadSilent = async () => {
    resetDiscordOutboundMocks(hoisted);
    const result = await sendText({
      ...target,
      to: "channel:parent-1",
      text: "threaded",
      replyToId: "reply-1",
      threadId: "thread-1",
      silent: true,
    });
    expect(sendMessage).toHaveBeenLastCalledWith("channel:thread-1", "threaded", {
      ...sendOptions,
      reply: { messageId: "reply-1", scope: "all" },
      silent: true,
    });
    expect(result.receipt).toMatchObject({ threadId: "thread-1", replyToId: "reply-1" });
  };

  await verifyChannelMessageAdapterCapabilityProofs({
    adapterName: "discordMessageAdapter",
    adapter,
    proofs: {
      text: proveText,
      media: proveMedia,
      poll: provePoll,
      payload: provePayload,
      silent: proveReplyThreadSilent,
      replyTo: proveReplyThreadSilent,
      thread: proveReplyThreadSilent,
      messageSendingHooks: () => {
        expect(sendText).toBeTypeOf("function");
      },
    },
  });
});

it.each([
  { source: "explicit", mode: "off", replies: ["parent-message", "parent-message"] },
  { source: "implicit", mode: "first", replies: ["parent-message", undefined] },
] as const)(
  "sends $source bound-thread replies through the native message endpoint",
  async ({ source, mode, replies }) => {
    resetDiscordOutboundMocks(hoisted);
    mockDiscordBoundThreadManager(hoisted);
    const sendText = discordPlugin.message?.send?.text;
    if (!sendText) {
      throw new Error("Expected Discord text sender");
    }
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ id: "thread-1", type: 11 });
    postMock.mockResolvedValueOnce({ id: "native-reply-1", channel_id: "thread-1" });
    postMock.mockResolvedValueOnce({ id: "native-reply-2", channel_id: "thread-1" });
    const cfg = { channels: { discord: { token: "fixture-token" } } };
    const result = await sendText({
      cfg,
      to: "channel:parent-1",
      accountId: "default",
      threadId: "thread-1",
      text: "x".repeat(2001),
      replyToId: "parent-message",
      replyToIdSource: source,
      replyToMode: mode,
      deps: {
        discord: async (...[to, text, options]: Parameters<typeof sendMessageDiscord>) =>
          await sendMessageDiscord(to, text, { ...options, cfg, rest, token: "fixture-token" }),
      },
    });
    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(2);
    expect([0, 1].map((index) => requestBody(postMock, index).message_reference)).toEqual(
      replies.map((messageId) =>
        messageId ? { message_id: messageId, fail_if_not_exists: false } : undefined,
      ),
    );
    expect(result.receipt.parts.map((part) => part.replyToId)).toEqual(replies);

    postMock.mockRejectedValueOnce(
      new DiscordError(new Response(null, { status: 403 }), {
        code: 50013,
        message: "Missing Permissions",
      }),
    );
    await expect(
      sendText({
        cfg,
        to: "channel:parent-1",
        accountId: "default",
        threadId: "thread-1",
        text: "permission failure",
        replyToId: "parent-message",
        replyToIdSource: source,
        replyToMode: mode,
        deps: {
          discord: async (...[to, text, options]: Parameters<typeof sendMessageDiscord>) =>
            await sendMessageDiscord(to, text, { ...options, cfg, rest, token: "fixture-token" }),
        },
      }),
    ).rejects.toThrow(/missing permissions/i);
    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
  },
);
