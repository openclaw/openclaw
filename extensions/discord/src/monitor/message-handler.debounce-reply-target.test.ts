import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
// Discord tests cover debounce partitioning by reply target.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

function createTextMessageData(
  messageId: string,
  channelId = "ch-1",
  authorId = "user-1",
  content = "hello",
) {
  return {
    channel_id: channelId,
    author: { id: authorId },
    message: {
      id: messageId,
      author: { id: authorId, bot: false },
      content,
      channel_id: channelId,
      attachments: [],
    },
  };
}

function createPreflightContext(channelId = "ch-1") {
  const discordConfig = {
    enabled: true,
    token: "test-token",
    groupPolicy: "allowlist" as const,
  };
  const cfg: OpenClawConfig = {
    channels: { discord: discordConfig },
    messages: { inbound: { debounceMs: 0 } },
  };
  return {
    ...createDiscordPreflightContext(channelId),
    cfg,
    accountId: "default",
    token: "test-token",
    runtime: {
      log: () => {},
      error: () => {},
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    textLimit: 2_000,
    replyToMode: "off" as const,
    discordConfig,
    messageText: "hello",
    isDirectMessage: false,
    isGuildMessage: true,
  };
}

describe("Discord reply-target debounce partitioning", () => {
  beforeEach(() => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
  });

  it("keeps replies to a different message out of an ordinary debounced batch", async () => {
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        message: preflightParams.data.message,
        messageText: preflightParams.data.message.content,
      }),
    );
    const handler = createDiscordMessageHandler(params);
    const ordinary = createTextMessageData("m-ordinary");
    const reply = createTextMessageData("m-other-bot-reply");
    Object.assign(reply.message, {
      messageReference: {
        type: 0,
        message_id: "m-other-bot",
        channel_id: reply.channel_id,
      },
      referencedMessage: {
        id: "m-other-bot",
        author: { id: "other-bot", bot: true },
      },
    });

    await handler(ordinary as never, {} as never);
    await handler(reply as never, {} as never);

    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(2);
    expect(
      preflightDiscordMessageMock.mock.calls.map(
        ([call]) =>
          (call as { data: ReturnType<typeof createTextMessageData> }).data.message.content,
      ),
    ).toEqual(["hello", "hello"]);
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(2);
  });

  it("preserves conversation-wide admission order across interleaved senders in one channel", async () => {
    // Releasing the per-channel ingress lane on defer (deferredLaneOccupancy:
    // "release" in ingress.ts) lets independent per-author debounce buffers
    // admit and flush concurrently. Without the cross-sender flush guard, a
    // later sender's message (B1) could flush ahead of an earlier sender's
    // still-buffering message (A1), inverting conversation order.
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 300 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: ReturnType<typeof createTextMessageData> }) => ({
        ...createPreflightContext(preflightParams.data.channel_id),
        message: preflightParams.data.message,
        messageText: preflightParams.data.message.content,
      }),
    );
    const handler = createDiscordMessageHandler(params);
    const a1 = createTextMessageData("order-a1", "ch-1", "user-a", "A1");
    const b1 = createTextMessageData("order-b1", "ch-1", "user-b", "B1");
    const a2 = createTextMessageData("order-a2", "ch-1", "user-a", "A2");

    await handler(a1 as never, {} as never);
    await handler(b1 as never, {} as never);
    await handler(a2 as never, {} as never);

    await expect.poll(() => preflightDiscordMessageMock.mock.calls.length).toBe(3);
    expect(
      preflightDiscordMessageMock.mock.calls.map(
        ([call]) =>
          (call as { data: ReturnType<typeof createTextMessageData> }).data.message.content,
      ),
    ).toEqual(["A1", "B1", "A2"]);
  });
});
