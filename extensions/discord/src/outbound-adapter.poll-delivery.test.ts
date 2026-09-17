// Discord tests cover poll delivery evidence through the outbound adapter.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordInboundEventDelivery } from "./inbound-event-delivery.js";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";
import { createDiscordSendReceipt } from "./send.receipt.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);
const { discordOutbound } = await import("./outbound-adapter.js");

describe("discordOutbound poll delivery", () => {
  beforeEach(() => resetDiscordOutboundMocks(hoisted));

  it("routes thread polls and reports their delivery evidence", async () => {
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const onDeliveryResult = vi.fn();
    const markInboundEventDelivered = vi.fn();
    const end = discordInboundEventDelivery.begin(
      "agent:main:discord:channel:parent-1",
      {
        outboundTo: "thread-1",
        outboundAccountId: "default",
        markInboundEventDelivered,
      },
      { inboundEventKind: "room_event" },
    );
    const pollResult = {
      messageId: "poll-1",
      channelId: "thread-1",
      receipt: createDiscordSendReceipt({
        platformMessageIds: ["poll-1"],
        channelId: "thread-1",
        kind: "poll",
        threadId: "thread-1",
      }),
    };
    hoisted.sendPollDiscordMock.mockImplementationOnce(async (_to, _poll, options) => {
      if (!options?.onDeliveryResult) {
        throw new Error("expected poll delivery callback");
      }
      await options.onDeliveryResult(pollResult);
      return pollResult;
    });

    let result;
    try {
      result = await discordOutbound.sendPoll?.({
        cfg: {},
        to: "channel:parent-1",
        poll: { question: "Best snack?", options: ["banana", "apple"] },
        content: "Vote now",
        accountId: "default",
        threadId: "thread-1",
        silent: true,
        sessionKey: "agent:main:discord:channel:parent-1",
        inboundEventKind: "room_event",
        onPlatformSendDispatch,
        onDeliveryResult,
      });
    } finally {
      end();
    }

    expect(hoisted.sendPollDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      { question: "Best snack?", options: ["banana", "apple"] },
      expect.objectContaining({
        accountId: "default",
        content: "Vote now",
        threadId: "thread-1",
        silent: true,
        onPlatformSendDispatch,
        onDeliveryResult: expect.any(Function),
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "poll-1",
      channelId: "thread-1",
      receipt: expect.objectContaining({
        primaryPlatformMessageId: "poll-1",
        threadId: "thread-1",
      }),
    });
    expect(markInboundEventDelivered).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "poll-1",
        target: { kind: "channel", id: "thread-1" },
        receipt: expect.objectContaining({ primaryPlatformMessageId: "poll-1" }),
      }),
    );
    expect(onDeliveryResult.mock.calls[0]?.[0]).not.toHaveProperty("channel");
  });
});
