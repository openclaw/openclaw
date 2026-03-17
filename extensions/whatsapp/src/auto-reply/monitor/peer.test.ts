import { describe, expect, it } from "vitest";
import type { WebInboundMsg } from "../types.js";
import { resolvePeerId } from "./peer.js";

function makeMessage(overrides: Record<string, unknown> = {}): WebInboundMsg {
  return {
    chatType: "direct",
    conversationId: "+15551234567",
    from: "+15551234567",
    to: "+15550000000",
    accountId: "default",
    body: "hi",
    chatId: "chat-1",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  } as unknown as WebInboundMsg;
}

describe("resolvePeerId", () => {
  it("falls back to conversationId when from is missing on direct messages", () => {
    expect(
      resolvePeerId(
        makeMessage({
          conversationId: "+15557654321",
          from: undefined,
        }),
      ),
    ).toBe("+15557654321");
  });

  it("returns unknown when direct messages have no sender identifiers", () => {
    expect(
      resolvePeerId(
        makeMessage({
          conversationId: undefined,
          from: undefined,
          senderE164: undefined,
        }),
      ),
    ).toBe("unknown");
  });
});
