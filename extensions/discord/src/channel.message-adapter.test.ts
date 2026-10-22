import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { beforeAll, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

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
