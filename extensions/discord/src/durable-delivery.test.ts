import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordPlugin: typeof import("./channel.js").discordPlugin;
let deliverDiscordReply: typeof import("./monitor/reply-delivery.js").deliverDiscordReply;

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ deliverDiscordReply } = await import("./monitor/reply-delivery.js"));
});

describe("durable Discord delivery", () => {
  const cfg = { channels: { discord: { token: "test-token" } } };
  const chunking = { chunkMode: "newline" as const, maxLinesPerMessage: 1, textLimit: 2000 };
  const chunks = ["first chunk", "second chunk"];

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect(hoisted.sendMessageDiscordMock.mock.calls.map((call) => call[1])).toEqual(chunks);
  });

  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    hoisted.sendMessageDiscordMock
      .mockResolvedValueOnce({ messageId: "msg-chunk-1", channelId: "ch-1" })
      .mockRejectedValueOnce(Object.assign(new Error("discord 500"), { status: 500 }));
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
    );
  });

  it("does not replay earlier chunks when a later platform send fails", async () => {
    const result = await sendDurableMessageBatch({
      cfg,
      channel: "discord",
      to: "channel:123456",
      payloads: [{ text: "first chunk\nsecond chunk" }],
      formatting: chunking,
      skipQueue: true,
    });

    expect(result).toMatchObject({
      status: "partial_failed",
      results: [{ channel: "discord", messageId: "msg-chunk-1" }],
      receipt: { platformMessageIds: ["msg-chunk-1"] },
      sentBeforeError: true,
    });
  });

  it("keeps accepted Discord chunks visible when monitored reply delivery fails", async () => {
    const error = await deliverDiscordReply({
      cfg,
      replies: [{ text: "first chunk\nsecond chunk" }],
      target: "channel:123456",
      token: "test-token",
      ...chunking,
      kind: "final",
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        messageIds: ["msg-chunk-1"],
        receipt: { platformMessageIds: ["msg-chunk-1"] },
        visibleReplySent: true,
      },
    });
  });
});
