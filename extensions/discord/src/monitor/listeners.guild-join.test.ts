import {
  ChannelType,
  PermissionFlagsBits,
  type APIMessage,
  type GatewayGuildCreateDispatchData,
} from "discord-api-types/v10";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import type { Client } from "../internal/discord.js";
import { DiscordGuildJoinIntroductionListener } from "./listeners.guild-join.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { cleanupDiscordProviderStartup } from "./provider.cleanup.js";
import { registerDiscordMonitorListeners } from "./provider.startup.js";
import { createNoopThreadBindingManager } from "./thread-bindings.manager.js";

const mocks = vi.hoisted(() => ({
  reportChannelRoomJoin: vi.fn(async () => ({ kind: "posted" as const })),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "molty",
    sessionKey: "agent:molty:discord:channel:system-channel",
  })),
  canViewDiscordGuildChannel: vi.fn(async () => true),
  hasAnyChannelPermissionDiscord: vi.fn(async () => true),
  readMessagesDiscord: vi.fn(async (): Promise<APIMessage[]> => []),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")>()),
  reportChannelRoomJoin: mocks.reportChannelRoomJoin,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: mocks.resolveAgentRoute,
}));

vi.mock("../send.permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.permissions.js")>()),
  canViewDiscordGuildChannel: mocks.canViewDiscordGuildChannel,
  hasAnyChannelPermissionDiscord: mocks.hasAnyChannelPermissionDiscord,
}));

vi.mock("../send.messages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.messages.js")>()),
  readMessagesDiscord: mocks.readMessagesDiscord,
}));

function guildCreateEvent(
  overrides: Partial<GatewayGuildCreateDispatchData> = {},
): GatewayGuildCreateDispatchData {
  return {
    id: "guild-1",
    name: "OpenClaw Guild",
    joined_at: new Date().toISOString(),
    system_channel_id: "system-channel",
    channels: [
      {
        id: "fallback-channel",
        name: "fallback",
        topic: "Fallback room",
        type: ChannelType.GuildText,
      },
      {
        id: "system-channel",
        name: "operations",
        topic: "Deployment coordination",
        type: ChannelType.GuildText,
      },
    ] as GatewayGuildCreateDispatchData["channels"],
    ...overrides,
  } as GatewayGuildCreateDispatchData;
}

function createListener(
  overrides: Partial<ConstructorParameters<typeof DiscordGuildJoinIntroductionListener>[0]> = {},
) {
  return new DiscordGuildJoinIntroductionListener({
    cfg: {},
    accountId: "work",
    botUserId: "bot-1",
    groupPolicy: "allowlist",
    guildEntries: {
      "guild-1": {
        requireMention: true,
        users: ["human-1"],
        channels: {
          "system-channel": { enabled: true },
          "fallback-channel": { enabled: true },
        },
      },
    },
    ...overrides,
  });
}

function createClient(): Client {
  return { rest: {}, listeners: [], fetchUser: vi.fn() } as unknown as Client;
}

function registerGuildJoinListener() {
  const client = createClient();
  const runtime = createRuntimeSpies();
  const stopMonitorListeners = registerDiscordMonitorListeners({
    cfg: {},
    client,
    accountId: "work",
    discordConfig: {},
    runtime,
    botUserId: "bot-1",
    dmEnabled: false,
    groupDmEnabled: false,
    dmPolicy: "disabled",
    groupPolicy: "open",
    logger: createSubsystemLogger("discord/test"),
    messageHandler: async () => {},
  });
  const listener = client.listeners.find(
    (entry): entry is DiscordGuildJoinIntroductionListener =>
      entry instanceof DiscordGuildJoinIntroductionListener,
  );
  if (!listener) {
    throw new Error("Guild introduction listener was not registered");
  }
  const dispose = vi.fn();
  return {
    client,
    listener,
    dispose,
    cleanup: () =>
      cleanupDiscordProviderStartup({
        stopMonitorListeners,
        lifecycleStarted: true,
        threadBindings: createNoopThreadBindingManager(),
        runtime,
        gatewaySupervisor: { dispose },
      }),
  };
}

describe("Discord guild join introductions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportChannelRoomJoin.mockReset().mockResolvedValue({ kind: "posted" });
    mocks.canViewDiscordGuildChannel.mockReset().mockResolvedValue(true);
    mocks.hasAnyChannelPermissionDiscord.mockReset().mockResolvedValue(true);
    mocks.readMessagesDiscord.mockReset().mockResolvedValue([]);
  });

  it("retires permission reads without accepting a report after provider cleanup", async () => {
    const entered = createDeferred<void>();
    const permission = createDeferred<boolean>();
    mocks.canViewDiscordGuildChannel.mockImplementationOnce(() => {
      entered.resolve();
      return permission.promise;
    });
    const { client, listener, cleanup, dispose } = registerGuildJoinListener();
    const pending = listener.handle(guildCreateEvent(), client);
    try {
      await entered.promise;
      await cleanup();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      permission.resolve(true);
      await pending;
    }
    await listener.handle(guildCreateEvent(), client);
    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
  });

  it("joins accepted report delivery and durable settlement before provider cleanup completes", async () => {
    const deliveryEntered = createDeferred<void>();
    const delivery = createDeferred<void>();
    const commitEntered = createDeferred<void>();
    const commit = createDeferred<void>();
    mocks.reportChannelRoomJoin.mockImplementationOnce(async () => {
      deliveryEntered.resolve();
      await delivery.promise;
      commitEntered.resolve();
      await commit.promise;
      return { kind: "posted" };
    });
    const { client, listener, cleanup, dispose } = registerGuildJoinListener();
    const pending = listener.handle(guildCreateEvent(), client);
    await deliveryEntered.promise;
    let cleaned = false;
    const stopped = cleanup().then(() => {
      cleaned = true;
    });
    try {
      // Drain a full event-loop turn so premature cleanup is observable at both awaits.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(cleaned).toBe(false);
      delivery.resolve();
      await commitEntered.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(cleaned).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
      await listener.handle(guildCreateEvent(), client);
      expect(reportChannelRoomJoin).toHaveBeenCalledOnce();
    } finally {
      delivery.resolve();
      commit.resolve();
      await pending;
      await stopped;
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("introduces the bot in the permitted system channel using readable room context", async () => {
    mocks.readMessagesDiscord.mockResolvedValue([
      {
        content: "Newest deployment",
        author: { username: "casey", global_name: "Casey" },
      } as APIMessage,
      { content: "Older rollout", author: { username: "alex", global_name: null } } as APIMessage,
    ]);

    await createListener().handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledOnce();
    const params = vi.mocked(reportChannelRoomJoin).mock.calls[0]?.[0];
    expect(params).toMatchObject({
      channel: "discord",
      accountId: "work",
      conversationId: "guild-1",
      deliverTo: "channel:system-channel",
      roomAllowed: true,
    });
    expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledWith(
      "guild-1",
      "system-channel",
      "bot-1",
      expect.objectContaining({ accountId: "work" }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "system-channel",
      "bot-1",
      [PermissionFlagsBits.SendMessages],
      expect.objectContaining({ accountId: "work" }),
    );
    await expect(params?.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#operations",
      purpose: "Deployment coordination",
      recentMessages: [
        { sender: "alex", text: "Older rollout" },
        { sender: "Casey", text: "Newest deployment" },
      ],
    });
  });

  it("rejects a guild introduction whose policy changes during permission lookup", async () => {
    const guilds = { "guild-1": { channels: { "system-channel": { enabled: true } } } };
    let cfg: OpenClawConfig = { channels: { discord: { groupPolicy: "allowlist", guilds } } };
    const readPolicy = createDiscordLivePolicyReader({
      cfg,
      accountId: "work",
      readConfig: () => cfg,
      resolvedAllowlist: { guildEntries: guilds, allowFrom: [] },
    });
    const entered = createDeferred<void>();
    const permission = createDeferred<boolean>();
    mocks.canViewDiscordGuildChannel.mockImplementationOnce(() => {
      entered.resolve();
      return permission.promise;
    });
    const listener = createListener({ cfg, readPolicy });
    const pending = listener.handle(guildCreateEvent(), createClient());
    await entered.promise;
    cfg = { channels: { discord: { groupPolicy: "disabled", guilds: {} } } };
    permission.resolve(true);
    await pending;
    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    await listener.handle(guildCreateEvent(), createClient());
    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ roomAllowed: false }),
    );
  });

  it("never introduces the bot for a stale guild-create reconnect snapshot", async () => {
    await createListener().handle(
      guildCreateEvent({ joined_at: new Date(Date.now() - 10 * 60 * 1_000).toISOString() }),
      createClient(),
    );

    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    expect(mocks.canViewDiscordGuildChannel).not.toHaveBeenCalled();
  });

  it("falls back to the first guild text channel the bot can both view and write", async () => {
    mocks.hasAnyChannelPermissionDiscord.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await createListener().handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:fallback-channel", roomAllowed: true }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledTimes(2);
  });

  it("skips a writable policy-denied system channel for an allowed fallback", async () => {
    await createListener({
      guildEntries: {
        "guild-1": { channels: { "fallback-channel": { enabled: true } } },
      },
    }).handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:fallback-channel", roomAllowed: true }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledTimes(2);
  });

  it("keeps the room metadata when Discord denies message-history access", async () => {
    mocks.readMessagesDiscord.mockRejectedValue(new Error("Missing ReadMessageHistory"));

    await createListener().handle(guildCreateEvent(), createClient());

    const params = vi.mocked(reportChannelRoomJoin).mock.calls[0]?.[0];
    await expect(params?.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#operations",
      purpose: "Deployment coordination",
    });
  });

  it("passes actual guild and channel admission to the core instead of sender authorization", async () => {
    await createListener({
      guildEntries: {
        "different-guild": { channels: { "system-channel": { enabled: true } } },
      },
    }).handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:system-channel", roomAllowed: false }),
    );
  });

  it("skips a guild with no writable text destination", async () => {
    mocks.canViewDiscordGuildChannel.mockResolvedValue(false);
    const logger = { info: vi.fn() };

    await createListener({ logger }).handle(guildCreateEvent(), createClient());

    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    expect(mocks.hasAnyChannelPermissionDiscord).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Discord guild join introduction skipped: no writable text channel",
      { guildId: "guild-1", accountId: "work" },
    );
  });
});
