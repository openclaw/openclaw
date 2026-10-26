import { expectDefined } from "@openclaw/normalization-core";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({ sendText: vi.fn(), sendMedia: vi.fn() }));

// mock-isolation: Record adapter routing without loading Urbit network state.
vi.mock("./channel.runtime.js", () => ({
  tlonRuntimeOutbound: mocks,
}));

import { tlonPlugin } from "./channel.js";

const cfg = {
  channels: {
    tlon: { ship: "~zod", url: "https://zod.example", code: "lidlut-tabwed-pillex-ridrup" },
  },
} as OpenClawConfig;

it("tlon target classification distinguishes ships from group nests", () => {
  expect(tlonPlugin.messaging?.inferTargetChatType?.({ to: "~sampel-palnet" })).toBe("direct");
  expect(tlonPlugin.messaging?.inferTargetChatType?.({ to: "chat/~sampel-palnet/operators" })).toBe(
    "group",
  );
});

it.each([
  {
    name: "DM",
    target: "tlon:dm/sampel-palnet",
    expected: {
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "~sampel-palnet" },
      chatType: "direct",
      from: "tlon:~sampel-palnet",
      to: "tlon:~sampel-palnet",
    },
  },
  {
    name: "group",
    target: "tlon:group:sampel-palnet/operators",
    expected: {
      sessionKey: "agent:main:tlon:group:chat/~sampel-palnet/operators",
      baseSessionKey: "agent:main:tlon:group:chat/~sampel-palnet/operators",
      recipientSessionExact: true,
      peer: { kind: "group", id: "chat/~sampel-palnet/operators" },
      chatType: "group",
      from: "tlon:group:chat/~sampel-palnet/operators",
      to: "tlon:chat/~sampel-palnet/operators",
    },
  },
  { name: "invalid", target: "not/a/target", expected: null },
])("tlon outbound session routing resolves $name targets", ({ target, expected }) => {
  const resolveOutboundSessionRoute = expectDefined(
    tlonPlugin.messaging?.resolveOutboundSessionRoute,
    "Tlon outbound session routing",
  );
  expect(
    resolveOutboundSessionRoute({ cfg, agentId: "main", accountId: "default", target }),
  ).toStrictEqual(expected);
});

describe("tlon channel message adapter", () => {
  beforeEach(() => {
    for (const [index, mock] of [mocks.sendText, mocks.sendMedia].entries()) {
      mock.mockReset().mockResolvedValue({
        channel: "tlon",
        messageId: `~zod/170000000000${index}`,
        conversationId: "~nec/general",
      });
    }
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = expectDefined(tlonPlugin.message, "Tlon message adapter");
    const sendText = expectDefined(adapter.send?.text, "Tlon text sender");
    const sendMedia = expectDefined(adapter.send?.media, "Tlon media sender");
    const context = { cfg, to: "chat/~nec/general", accountId: "default" };
    const proveSend = async (kind: "text" | "media") => {
      const mock = kind === "text" ? mocks.sendText : mocks.sendMedia;
      const mediaUrl = "https://example.com/image.png";
      const params = {
        ...context,
        text: kind === "text" ? "hello" : "image",
        ...(kind === "media" ? { mediaUrl } : {}),
      };
      mock.mockClear();
      const result = await (kind === "text"
        ? sendText(params)
        : sendMedia({ ...params, mediaUrl }));
      expect(mock).toHaveBeenLastCalledWith({
        ...params,
        replyToId: undefined,
        threadId: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual([
        kind === "text" ? "~zod/1700000000000" : "~zod/1700000000001",
      ]);
      expect(result.receipt.parts[0]?.kind).toBe(kind);
    };

    const proveReplyThread = async () => {
      mocks.sendText.mockClear();
      const params = {
        ...context,
        text: "threaded",
        replyToId: "1700000000000",
        threadId: "1700000000000",
      };
      const result = await sendText(params);
      expect(mocks.sendText).toHaveBeenLastCalledWith(params);
      expect(result.receipt.replyToId).toBe("1700000000000");
      expect(result.receipt.threadId).toBe("1700000000000");
    };

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "tlonMessageAdapter",
      adapter,
      proofs: {
        text: () => proveSend("text"),
        media: () => proveSend("media"),
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
