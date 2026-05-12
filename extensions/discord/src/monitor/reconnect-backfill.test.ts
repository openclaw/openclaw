import type { APIMessage } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRestClient } from "../internal/test-builders.test-support.js";
import {
  recordRecentDiscordOutboundMessage,
  resetRecentDiscordOutboundMessagesForTest,
} from "../recent-outbound.js";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";
import {
  backfillRecentDiscordInboundMessages,
  resetRecentDiscordBackfillsForTest,
} from "./reconnect-backfill.js";

async function flushQueueWork(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function apiMessage(overrides: Partial<APIMessage> & Pick<APIMessage, "id">): APIMessage {
  return {
    channel_id: "thread-1",
    content: "reply",
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date().toISOString(),
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      global_name: null,
      avatar: null,
    },
    type: 0,
    tts: false,
    pinned: false,
    flags: 0 as APIMessage["flags"],
    ...overrides,
  } as APIMessage;
}

describe("backfillRecentDiscordInboundMessages", () => {
  beforeEach(() => {
    resetRecentDiscordOutboundMessagesForTest();
    resetRecentDiscordBackfillsForTest();
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
  });

  it("replays user messages after recent OpenClaw outbound messages in oldest-first order", async () => {
    const rest = createFakeRestClient([
      [apiMessage({ id: "103", content: "second" }), apiMessage({ id: "102", content: "first" })],
    ]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const messageHandler = vi.fn(async (_data: unknown, _client?: unknown) => {});

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "101",
      at: 1_000,
    });
    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "101-later",
      at: 1_500,
    });

    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 2_000,
    });

    expect(rest.calls[0]).toMatchObject({
      method: "GET",
      query: { after: "101", limit: 50 },
    });
    expect(messageHandler).toHaveBeenCalledTimes(2);
    const firstEvent = messageHandler.mock.calls[0]?.[0] as {
      message: { id: string };
      guild_id?: string;
    };
    const secondEvent = messageHandler.mock.calls[1]?.[0] as { message: { id: string } };
    expect(firstEvent.message.id).toBe("102");
    expect(firstEvent.guild_id).toBe("guild-1");
    expect(secondEvent.message.id).toBe("103");
  });

  it("does not rescan the same outbound anchor during the reconnect cooldown", async () => {
    const rest = createFakeRestClient([[apiMessage({ id: "102" })], [apiMessage({ id: "103" })]]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const messageHandler = vi.fn(async (_data: unknown, _client?: unknown) => {});

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "101",
      at: 1_000,
    });

    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 2_000,
    });
    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 2_100,
    });

    expect(rest.calls).toHaveLength(1);
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it("shares the replay guard between REST backfill and gateway delivery", async () => {
    const rest = createFakeRestClient([[apiMessage({ id: "102" })]]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    preflightDiscordMessageMock.mockImplementation(async () =>
      createDiscordPreflightContext("thread-1"),
    );
    processDiscordMessageMock.mockResolvedValue(undefined);
    const handler = createDiscordMessageHandler(createDiscordHandlerParams());

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "101",
      at: 1_000,
    });

    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler: handler,
      botUserId: "bot-1",
      now: 2_000,
    });
    await flushQueueWork();
    await handler(
      {
        channel_id: "thread-1",
        author: { id: "user-1" },
        message: {
          id: "102",
          author: { id: "user-1", bot: false },
          content: "reply",
          channel_id: "thread-1",
          attachments: [],
        },
      } as never,
      client,
    );
    await flushQueueWork();

    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay bot-authored messages", async () => {
    const rest = createFakeRestClient([
      [
        apiMessage({
          id: "102",
          author: {
            id: "bot-1",
            username: "bot",
            discriminator: "0",
            global_name: null,
            avatar: null,
            bot: true,
          },
        }),
      ],
    ]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const messageHandler = vi.fn(async (_data: unknown, _client?: unknown) => {});

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "101",
      at: 1_000,
    });

    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 2_000,
    });

    expect(messageHandler).not.toHaveBeenCalled();
  });
});
