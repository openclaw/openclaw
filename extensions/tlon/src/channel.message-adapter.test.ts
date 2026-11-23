// Tlon tests cover channel.message adapter plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  tlonRuntimeOutbound: {
    sendText: mocks.sendText,
    sendMedia: mocks.sendMedia,
  },
}));

import { tlonPlugin } from "./channel.js";

const cfg = {
  channels: {
    tlon: {
      ship: "~zod",
      url: "https://zod.example",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
} as OpenClawConfig;

describe("tlon target classification", () => {
  it("distinguishes ships from group nests", () => {
    expect(tlonPlugin.messaging?.inferTargetChatType?.({ to: "~sampel-palnet" })).toBe("direct");
    expect(
      tlonPlugin.messaging?.inferTargetChatType?.({ to: "chat/~sampel-palnet/operators" }),
    ).toBe("group");
  });
});

describe("tlon channel message adapter", () => {
  beforeEach(() => {
    mocks.sendText.mockReset();
    mocks.sendMedia.mockReset();
    mocks.sendText.mockResolvedValue({
      channel: "tlon",
      messageId: "~zod/1700000000000",
      conversationId: "~nec/general",
    });
    mocks.sendMedia.mockResolvedValue({
      channel: "tlon",
      messageId: "~zod/1700000000001",
      conversationId: "~nec/general",
    });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = tlonPlugin.message;
    if (!adapter?.send?.text || !adapter.send.media) {
      throw new Error("expected tlon channel message adapter with text and media senders");
    }
    const sendText = adapter.send.text;
    const sendMedia = adapter.send.media;

    const proveText = async () => {
      mocks.sendText.mockClear();
      const result = await sendText({
        cfg,
        to: "chat/~nec/general",
        text: "hello",
        accountId: "default",
      });
      expect(mocks.sendText).toHaveBeenLastCalledWith({
        cfg,
        to: "chat/~nec/general",
        text: "hello",
        accountId: "default",
        replyToId: undefined,
        threadId: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["~zod/1700000000000"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      mocks.sendMedia.mockClear();
      const result = await sendMedia({
        cfg,
        to: "chat/~nec/general",
        text: "image",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
      });
      expect(mocks.sendMedia).toHaveBeenLastCalledWith({
        cfg,
        to: "chat/~nec/general",
        text: "image",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
        replyToId: undefined,
        threadId: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["~zod/1700000000001"]);
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const proveReplyThread = async () => {
      mocks.sendText.mockClear();
      const result = await sendText({
        cfg,
        to: "chat/~nec/general",
        text: "threaded",
        accountId: "default",
        replyToId: "1700000000000",
        threadId: "1700000000000",
      });
      expect(mocks.sendText).toHaveBeenLastCalledWith({
        cfg,
        to: "chat/~nec/general",
        text: "threaded",
        accountId: "default",
        replyToId: "1700000000000",
        threadId: "1700000000000",
      });
      expect(result.receipt.replyToId).toBe("1700000000000");
      expect(result.receipt.threadId).toBe("1700000000000");
    };

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "tlonMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        replyTo: proveReplyThread,
        thread: proveReplyThread,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
    expect(proofs).toStrictEqual([
      { capability: "text", status: "verified" },
      { capability: "media", status: "verified" },
      { capability: "poll", status: "not_declared" },
      { capability: "payload", status: "not_declared" },
      { capability: "silent", status: "not_declared" },
      { capability: "replyTo", status: "verified" },
      { capability: "thread", status: "verified" },
      { capability: "nativeQuote", status: "not_declared" },
      { capability: "messageSendingHooks", status: "verified" },
      { capability: "batch", status: "not_declared" },
      { capability: "reconcileUnknownSend", status: "not_declared" },
      { capability: "afterSendSuccess", status: "not_declared" },
      { capability: "afterCommit", status: "not_declared" },
    ]);
  });
});

it.each([
  ["tlon:dm/sampel-palnet", "direct", "~sampel-palnet", "agent:main:main"],
  [
    "tlon:group:sampel-palnet/operators",
    "group",
    "chat/~sampel-palnet/operators",
    "agent:main:tlon:group:chat/~sampel-palnet/operators",
  ],
  ["tlon:club:0v1.abcde", "group", "club:0v1.abcde", "agent:main:tlon:group:club:0v1.abcde"],
  ["club:0v1.xyz", null, "", ""],
  ["not/a/target", null, "", ""],
] as const)("tlon outbound session routing resolves %s", (target, kind, id, sessionKey) => {
  const resolveOutboundSessionRoute = expectDefined(
    tlonPlugin.messaging?.resolveOutboundSessionRoute,
    "Tlon outbound session routing",
  );
  expect(
    resolveOutboundSessionRoute({ cfg, agentId: "main", accountId: "default", target }),
  ).toStrictEqual(
    kind === null
      ? null
      : {
          sessionKey,
          baseSessionKey: sessionKey,
          recipientSessionExact: true,
          peer: { kind, id },
          chatType: kind,
          from: kind === "group" && !id.startsWith("club:") ? `tlon:group:${id}` : `tlon:${id}`,
          to: `tlon:${id}`,
        },
  );
});
