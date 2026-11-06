import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendText: vi.fn(), sendMedia: vi.fn() }));

// mock-isolation: Record adapter routing without loading Urbit network state.
vi.mock("./channel.runtime.js", () => ({
  tlonRuntimeOutbound: mocks,
}));

import { tlonPlugin } from "./channel.js";

const cfg = {};

it("tlon target classification distinguishes ships from group nests", () => {
  expect(tlonPlugin.messaging?.inferTargetChatType?.({ to: "~sampel-palnet" })).toBe("direct");
  expect(tlonPlugin.messaging?.inferTargetChatType?.({ to: "chat/~sampel-palnet/operators" })).toBe(
    "group",
  );
});

it.each([
  ["tlon:dm/sampel-palnet", "direct", "~sampel-palnet", "agent:main:main"],
  [
    "tlon:group:sampel-palnet/operators",
    "group",
    "chat/~sampel-palnet/operators",
    "agent:main:tlon:group:chat/~sampel-palnet/operators",
  ],
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
          from: kind === "group" ? `tlon:group:${id}` : `tlon:${id}`,
          to: `tlon:${id}`,
        },
  );
});

it("preserves reply and thread metadata in the preferred adapter receipt", async () => {
  mocks.sendText.mockReset().mockResolvedValue({
    channel: "tlon",
    messageId: "~zod/1700000000000",
    conversationId: "~nec/general",
  });
  const adapter = expectDefined(tlonPlugin.message, "Tlon message adapter");
  const sendText = expectDefined(adapter.send?.text, "Tlon text sender");
  const params = {
    cfg,
    to: "chat/~nec/general",
    accountId: "default",
    text: "threaded",
    replyToId: "1700000000000",
    threadId: "1700000000000",
  };
  const result = await sendText(params);
  expect(mocks.sendText).toHaveBeenLastCalledWith(params);
  expect(result.receipt.replyToId).toBe("1700000000000");
  expect(result.receipt.threadId).toBe("1700000000000");
});
