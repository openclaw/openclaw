// Discord tests cover channel.message adapter plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

type DiscordMessageAdapter = NonNullable<typeof discordPlugin.message>;

function requireDiscordMessageAdapter(): DiscordMessageAdapter {
  const adapter = discordPlugin.message;
  if (!adapter) {
    throw new Error("Expected discord plugin to expose a channel message adapter");
  }
  return adapter;
}

describe("discord channel message adapter", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = requireDiscordMessageAdapter();
    const {
      text: sendText,
      media: sendMedia,
      payload: sendPayload,
      poll: sendPoll,
    } = adapter.send ?? {};
    if (!sendText || !sendMedia || !sendPayload || !sendPoll) {
      throw new Error("Expected Discord text, media, payload, and poll senders");
    }

    const proveText = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendText({
        cfg: {},
        to: "channel:123456",
        text: "hello",
        accountId: "default",
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith("channel:123456", "hello", {
        verbose: false,
        reply: undefined,
        accountId: "default",
        silent: undefined,
        cfg: {},
        textLimit: undefined,
        maxLinesPerMessage: undefined,
        tableMode: undefined,
        chunkMode: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendMedia({
        cfg: {},
        to: "channel:123456",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        accountId: "default",
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith("channel:123456", "caption", {
        verbose: false,
        mediaUrl: "https://example.com/a.png",
        mediaAccess: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
        reply: undefined,
        accountId: "default",
        silent: undefined,
        cfg: {},
        textLimit: undefined,
        maxLinesPerMessage: undefined,
        tableMode: undefined,
        chunkMode: undefined,
      });
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const provePayload = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendPayload({
        cfg: {},
        to: "channel:123456",
        text: "payload",
        payload: { text: "payload" },
        accountId: "default",
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith(
        "channel:123456",
        "payload",
        expect.objectContaining({
          verbose: false,
          reply: undefined,
          accountId: "default",
          silent: undefined,
          cfg: {},
          textLimit: undefined,
          maxLinesPerMessage: undefined,
          tableMode: undefined,
          chunkMode: undefined,
          onDeliveryResult: expect.any(Function),
        }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    };

    const provePoll = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendPoll({
        cfg: {},
        to: "channel:123456",
        poll: { question: "Ship?", options: ["Yes", "No"] },
        accountId: "default",
        silent: true,
      });
      expect(hoisted.sendPollDiscordMock).toHaveBeenLastCalledWith(
        "channel:123456",
        { question: "Ship?", options: ["Yes", "No"] },
        expect.objectContaining({
          accountId: "default",
          silent: true,
          cfg: {},
          onDeliveryResult: expect.any(Function),
        }),
      );
      expect(result.receipt.parts[0]?.kind).toBe("poll");
    };

    const proveReplyThreadSilent = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendText({
        cfg: {},
        to: "channel:parent-1",
        text: "threaded",
        accountId: "default",
        replyToId: "reply-1",
        threadId: "thread-1",
        silent: true,
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith(
        "channel:thread-1",
        "threaded",
        {
          verbose: false,
          accountId: "default",
          reply: { messageId: "reply-1", scope: "all" },
          silent: true,
          cfg: {},
          textLimit: undefined,
          maxLinesPerMessage: undefined,
          tableMode: undefined,
          chunkMode: undefined,
        },
      );
      expect(result.receipt.threadId).toBe("thread-1");
      expect(result.receipt.replyToId).toBe("reply-1");
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

  it("declares fresh final delivery and pending preview cleanup", () => {
    const adapter = requireDiscordMessageAdapter();
    expect(adapter.live?.capabilities).toEqual({
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
    });
    expect(adapter.live?.finalizer?.capabilities).toEqual({
      finalEdit: false,
      normalFallback: true,
      discardPending: true,
    });
  });
});
