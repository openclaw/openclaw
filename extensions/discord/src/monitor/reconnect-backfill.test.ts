import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { APIMessage } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeRestClient } from "../internal/test-builders.test-support.js";
import {
  clearRecentDiscordInboundPersistenceForTest,
  recordRecentDiscordInboundMessage,
  resetRecentDiscordInboundMessagesForTest,
} from "../recent-inbound.js";
import {
  clearRecentDiscordOutboundPersistenceForTest,
  listRecentDiscordOutboundMessages,
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
  getRecentDiscordBackfillCooldownCountForTest,
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

const previousRecentOutboundStorePath = process.env.OPENCLAW_DISCORD_RECENT_OUTBOUND_STORE_PATH;
const previousRecentInboundStorePath = process.env.OPENCLAW_DISCORD_RECENT_INBOUND_STORE_PATH;
const recentOutboundStorePath = path.join(
  os.tmpdir(),
  `openclaw-discord-recent-outbound-${process.pid}.json`,
);
const recentInboundStorePath = path.join(
  os.tmpdir(),
  `openclaw-discord-recent-inbound-${process.pid}.json`,
);

describe("backfillRecentDiscordInboundMessages", () => {
  beforeEach(() => {
    process.env.OPENCLAW_DISCORD_RECENT_OUTBOUND_STORE_PATH = recentOutboundStorePath;
    process.env.OPENCLAW_DISCORD_RECENT_INBOUND_STORE_PATH = recentInboundStorePath;
    clearRecentDiscordOutboundPersistenceForTest();
    clearRecentDiscordInboundPersistenceForTest();
    resetRecentDiscordOutboundMessagesForTest();
    resetRecentDiscordInboundMessagesForTest();
    resetRecentDiscordBackfillsForTest();
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
  });

  afterEach(() => {
    clearRecentDiscordOutboundPersistenceForTest();
    clearRecentDiscordInboundPersistenceForTest();
    resetRecentDiscordOutboundMessagesForTest();
    resetRecentDiscordInboundMessagesForTest();
    if (previousRecentOutboundStorePath === undefined) {
      delete process.env.OPENCLAW_DISCORD_RECENT_OUTBOUND_STORE_PATH;
    } else {
      process.env.OPENCLAW_DISCORD_RECENT_OUTBOUND_STORE_PATH = previousRecentOutboundStorePath;
    }
    if (previousRecentInboundStorePath === undefined) {
      delete process.env.OPENCLAW_DISCORD_RECENT_INBOUND_STORE_PATH;
    } else {
      process.env.OPENCLAW_DISCORD_RECENT_INBOUND_STORE_PATH = previousRecentInboundStorePath;
    }
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

  it("persists recent outbound anchors across full process restarts", async () => {
    const rest = createFakeRestClient([[apiMessage({ id: "202", content: "missed" })]]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const messageHandler = vi.fn(async (_data: unknown, _client?: unknown) => {});

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "201",
      at: 1_000,
    });

    expect(fs.existsSync(recentOutboundStorePath)).toBe(true);
    resetRecentDiscordOutboundMessagesForTest();

    expect(
      listRecentDiscordOutboundMessages({ accountId: "default", maxAgeMs: 60_000, now: 2_000 }),
    ).toEqual([
      {
        accountId: "default",
        channelId: "thread-1",
        messageId: "201",
        at: 1_000,
      },
    ]);

    resetRecentDiscordOutboundMessagesForTest();
    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 2_000,
    });

    expect(rest.calls[0]).toMatchObject({
      method: "GET",
      query: { after: "201", limit: 50 },
    });
    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it("does not replay inbound messages already processed before a restart", async () => {
    const rest = createFakeRestClient([[apiMessage({ id: "202", content: "already handled" })]]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const messageHandler = vi.fn(async (_data: unknown, _client?: unknown) => {});

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "201",
      at: 1_000,
    });
    recordRecentDiscordInboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "202",
      at: 1_500,
    });

    resetRecentDiscordOutboundMessagesForTest();
    resetRecentDiscordInboundMessagesForTest();
    const stats = await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 2_000,
    });

    expect(rest.calls[0]).toMatchObject({
      method: "GET",
      query: { after: "201", limit: 50 },
    });
    expect(messageHandler).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      candidates: 1,
      skippedAlreadyProcessed: 1,
      replayed: 0,
    });
  });

  it("reports reconnect backfill outcome stats", async () => {
    const rest = createFakeRestClient([[apiMessage({ id: "302" })]]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const messageHandler = vi.fn(async (_data: unknown, _client?: unknown) => {});
    const logger = { info: vi.fn(), error: vi.fn() };

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "301",
      at: 1_000,
    });

    const stats = await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      logger: logger as never,
      now: 2_000,
    });

    expect(stats).toMatchObject({
      anchorsAvailable: 1,
      anchorsScanned: 1,
      channelsScanned: 1,
      candidates: 1,
      replayed: 1,
      errors: 0,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Discord reconnect backfill complete",
      expect.objectContaining({ anchorsAvailable: 1, replayed: 1 }),
    );
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

  it("prunes expired cooldown entries for outbound anchors outside the backfill window", async () => {
    const rest = createFakeRestClient([
      [apiMessage({ id: "102" })],
      [apiMessage({ id: "902002" })],
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

    expect(getRecentDiscordBackfillCooldownCountForTest()).toBe(1);

    recordRecentDiscordOutboundMessage({
      accountId: "default",
      channelId: "thread-1",
      messageId: "902001",
      at: 902_000,
    });

    await backfillRecentDiscordInboundMessages({
      accountId: "default",
      client,
      messageHandler,
      botUserId: "bot-1",
      now: 903_000,
    });

    expect(rest.calls).toHaveLength(2);
    expect(rest.calls[1]).toMatchObject({
      method: "GET",
      query: { after: "902001", limit: 50 },
    });
    expect(getRecentDiscordBackfillCooldownCountForTest()).toBe(1);
  });

  it("shares the replay guard between REST backfill and gateway delivery", async () => {
    const rest = createFakeRestClient([[apiMessage({ id: "102" })]]);
    const client = {
      rest,
      fetchChannel: vi.fn(async () => ({ id: "thread-1", guildId: "guild-1" })),
    } as never;
    const handlerParams = createDiscordHandlerParams();
    preflightDiscordMessageMock.mockImplementation(async () => ({
      ...createDiscordPreflightContext("thread-1"),
      cfg: handlerParams.cfg,
      discordConfig: handlerParams.discordConfig,
      accountId: handlerParams.accountId,
      token: handlerParams.token,
      runtime: handlerParams.runtime,
      guildHistories: handlerParams.guildHistories,
      historyLimit: handlerParams.historyLimit,
      mediaMaxBytes: handlerParams.mediaMaxBytes,
      textLimit: handlerParams.textLimit,
      replyToMode: handlerParams.replyToMode,
      threadBindings: handlerParams.threadBindings,
      client,
    }));
    processDiscordMessageMock.mockResolvedValue(undefined);
    const handler = createDiscordMessageHandler(handlerParams);

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
