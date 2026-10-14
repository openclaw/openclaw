import {
  ChannelType,
  PermissionFlagsBits,
  type APIMessage,
  type GatewayGuildCreateDispatchData,
  type GatewayPresenceUpdate,
  PresenceUpdateStatus,
  type GatewayThreadUpdateDispatchData,
} from "discord-api-types/v10";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../internal/discord.js";
import { DiscordPresenceGuildDeleteListener, DiscordPresenceListener } from "./listeners.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicy } from "./live-policy.js";
import { clearPresences, getPresence } from "./presence-cache.js";
import { DiscordPresenceBaselineCache } from "./presence-transition-cache.js";
import { cleanupDiscordProviderStartup } from "./provider.cleanup.js";
import { registerDiscordMonitorListeners } from "./provider.startup.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const lifecycle = vi.hoisted(() => {
  const unbindThread = vi.fn();
  return {
    closeDiscordThreadSessions: vi.fn(async () => 1),
    unbindThread,
    getThreadBindingManager: vi.fn(() => ({ unbindThread })),
  };
});
vi.mock("./thread-session-close.js", () => ({
  closeDiscordThreadSessions: lifecycle.closeDiscordThreadSessions,
}));
vi.mock("./thread-bindings.manager.js", () => ({
  getThreadBindingManager: lifecycle.getThreadBindingManager,
}));

const mocks = vi.hoisted(() => ({
  reportChannelRoomJoin: vi.fn(async () => ({ kind: "posted" as const })),
  enqueueSystemEvent: vi.fn((_text: unknown, _options: Record<string, unknown>) => true),
  requestHeartbeat: vi.fn(),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "molty",
    sessionKey: "agent:molty:discord:channel:channel-1",
  })),
  canViewDiscordGuildChannel: vi.fn(async () => true),
  hasAnyChannelPermissionDiscord: vi.fn(async () => true),
  readMessagesDiscord: vi.fn(async (): Promise<APIMessage[]> => []),
}));

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-join-intro-runtime")>()),
  reportChannelRoomJoin: mocks.reportChannelRoomJoin,
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

vi.mock("openclaw/plugin-sdk/heartbeat-runtime", () => ({
  requestHeartbeat: mocks.requestHeartbeat,
}));
vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: mocks.resolveAgentRoute,
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { agentId: unknown; sessionKey: unknown },
    options: Record<string, unknown>,
  ) =>
    mocks.enqueueSystemEvent(text, {
      ...options,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    }),
}));
function thread(archived: boolean): GatewayThreadUpdateDispatchData {
  return {
    id: "thread-42",
    type: ChannelType.PublicThread,
    guild_id: "guild-1",
    parent_id: "channel-1",
    name: "support thread",
    thread_metadata: {
      archived,
      auto_archive_duration: 60,
      archive_timestamp: "2026-08-09T00:00:00.000Z",
      locked: false,
    },
  };
}

function guildCreateEvent(): GatewayGuildCreateDispatchData {
  return {
    id: "guild-1",
    name: "OpenClaw Guild",
    joined_at: new Date().toISOString(),
    system_channel_id: "system-channel",
    channels: [
      {
        id: "fallback-channel",
        name: "fallback",
        type: ChannelType.GuildText,
      },
      {
        id: "system-channel",
        name: "operations",
        topic: "Deployment coordination",
        type: ChannelType.GuildText,
      },
    ] as GatewayGuildCreateDispatchData["channels"],
  } as GatewayGuildCreateDispatchData;
}

function presence(status: "online" | "offline", userId = "user-1"): GatewayPresenceUpdate {
  return {
    guild_id: "guild-1",
    status: status === "online" ? PresenceUpdateStatus.Online : PresenceUpdateStatus.Offline,
    activities: [],
    client_status: {},
    user: { id: userId, username: "Alice" },
  };
}

function guildSnapshot(
  presences: Array<Omit<GatewayPresenceUpdate, "guild_id">>,
  memberCount = 100,
): GatewayGuildCreateDispatchData {
  return {
    id: "guild-1",
    member_count: memberCount,
    presences,
  } as GatewayGuildCreateDispatchData;
}

function presenceClient(fetchUser = async () => ({ bot: false })): Client {
  return { fetchUser: vi.fn(fetchUser) } as unknown as Client;
}

function cooldownStore(values = new Map<string, number>()) {
  return {
    register: async (key, value) => void values.set(key, value),
    registerIfAbsent: async (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: async (key) => values.get(key),
    consume: async (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: async (key) => values.delete(key),
    deleteIfEqual: async (key, expected) => values.get(key) === expected && values.delete(key),
    entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: value })),
    clear: async () => values.clear(),
  } satisfies PluginStateKeyedStore<number>;
}

type PresenceListenerParams = ConstructorParameters<typeof DiscordPresenceListener>[0];
type PresenceEventConfig = NonNullable<
  NonNullable<PresenceListenerParams["guildEntries"]>[string]["presenceEvents"]
>;
type PresenceListenerOverrides = Partial<PresenceListenerParams> & {
  presenceEvents?: Partial<PresenceEventConfig>;
};
let nowMs = 1_000;

function createPresenceListener({
  presenceEvents,
  ...overrides
}: PresenceListenerOverrides = {}): DiscordPresenceListener {
  return new DiscordPresenceListener({
    cfg: {},
    accountId: "molty",
    guildEntries: {
      "guild-1": { presenceEvents: { channelId: "channel-1", ...presenceEvents } },
    },
    cooldownStore: cooldownStore(),
    nowMs: () => nowMs,
    ...overrides,
  });
}

function expectWake(...userIds: string[]) {
  expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(userIds.length);
  expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(userIds.length);
  for (const userId of userIds) {
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(`user_id="${userId}"`),
      expect.anything(),
    );
  }
}

function pause<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
  const entered = createDeferred<void>();
  const ready = createDeferred<void>();
  return {
    entered: entered.promise,
    resolve: ready.resolve,
    run: async (...args: Args): Promise<Result> => {
      entered.resolve();
      await ready.promise;
      return await operation(...args);
    },
  };
}

function livePresencePolicy(users?: string[], channelId = "channel-1"): DiscordLivePolicy {
  const guildEntries = {
    "guild-1": { presenceEvents: { channelId, users } },
  };
  return {
    isCurrent: () => true,
    cfg: {},
    accountId: "molty",
    discordConfig: { guilds: guildEntries },
    guildEntries,
    allowFrom: [],
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    dmEnabled: true,
    groupDmEnabled: false,
    groupDmChannels: [],
    allowNameMatching: false,
  };
}

function createHarness(
  overrides: Partial<Parameters<typeof registerDiscordMonitorListeners>[0]> = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  const logger = createSubsystemLogger("discord/test-listeners");
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  const client = new Client(
    {
      clientId: "test-app",
      token: "test-token",
      requestOptions: { fetch },
      eventQueue: { listenerTimeout: 120_000, slowListenerThreshold: 30_000 },
    },
    {},
  );
  const onEvent = vi.fn();
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const stopMonitorListeners = registerDiscordMonitorListeners({
    cfg: {},
    client,
    accountId: "work",
    botUserId: "bot-1",
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
    discordConfig: {},
    runtime,
    dmEnabled: false,
    groupDmEnabled: false,
    dmPolicy: "disabled",
    groupPolicy: "allowlist",
    logger,
    messageHandler: vi.fn(async () => {}),
    trackInboundEvent: onEvent,
    ...overrides,
  });
  const update = (archived = false) =>
    client.dispatchGatewayEvent("THREAD_UPDATE", thread(archived));
  const dispose = vi.fn();
  const joinGuild = () => client.dispatchGatewayEvent("GUILD_CREATE", guildCreateEvent());
  const cleanup = () =>
    cleanupDiscordProviderStartup({
      stopMonitorListeners,
      lifecycleStarted: true,
      threadBindings: createNoopThreadBindingManager(),
      runtime,
      gatewaySupervisor: { dispose },
    });
  return { client, fetch, logger, onEvent, update, joinGuild, cleanup, dispose };
}

const denied = () =>
  new Response(JSON.stringify({ message: "Missing Permissions", code: 50013 }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });

const humanClient = presenceClient();
beforeEach(() => {
  nowMs = 1_000;
  clearPresences();
  vi.clearAllMocks();
  mocks.reportChannelRoomJoin.mockReset().mockResolvedValue({ kind: "posted" });
  mocks.canViewDiscordGuildChannel.mockReset().mockResolvedValue(true);
  mocks.hasAnyChannelPermissionDiscord.mockReset().mockResolvedValue(true);
  mocks.readMessagesDiscord.mockReset().mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

describe("Discord monitor dispatch", () => {
  it("tracks concurrent messages while awaiting each handler's completion", async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const entered = createDeferred<void>();
    let calls = 0;
    const handler = vi.fn(async () => {
      const pending = ++calls === 1 ? first : second;
      if (calls === 2) {
        entered.resolve();
      }
      await pending.promise;
    });
    const { client, onEvent } = createHarness({ messageHandler: handler });
    const completed = vi.fn();
    const a = client.dispatchGatewayEvent("MESSAGE_CREATE", { channel_id: "ch-1" }).then(completed);
    const b = client.dispatchGatewayEvent("MESSAGE_CREATE", { channel_id: "ch-1" });
    try {
      await entered.promise;
      expect(onEvent).toHaveBeenCalledTimes(2);
      second.resolve();
      await b;
      expect(completed).not.toHaveBeenCalled();
    } finally {
      first.resolve();
      second.resolve();
      await Promise.all([a, b]);
    }
    expect(completed).toHaveBeenCalledOnce();
  });

  it("detaches interaction handling and reports its eventual failure", async () => {
    const { client, logger, onEvent } = createHarness();
    const pending = createDeferred<void>();
    const logged = createDeferred<void>();
    const handler = vi.spyOn(client, "handleInteraction").mockReturnValue(pending.promise);
    vi.mocked(logger.error).mockImplementation(() => logged.resolve());
    await client.dispatchGatewayEvent("INTERACTION_CREATE", { id: "interaction-1" });
    expect(handler).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    pending.reject(new Error("interaction boom"));
    await logged.promise;
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("discord interaction handler failed: Error: interaction boom"),
    );
  });

  it("logs failed thread rejoin REST and retries on the next update", async () => {
    const { fetch, logger, update } = createHarness();
    fetch.mockResolvedValueOnce(denied());
    await update();
    await update();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Missing Permissions"), {
      threadId: "thread-42",
    });
  });

  it.each(["archive", "READY"] as const)(
    "keeps the replacement rejoin claim when an old request fails after %s",
    async (reset) => {
      const { client, fetch, update } = createHarness();
      const oldResponse = pause(async () => denied());
      fetch.mockImplementationOnce(oldResponse.run);
      const oldUpdate = update();
      let newUpdate: Promise<void> | undefined;
      try {
        await oldResponse.entered;
        await update();
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith(
          "https://discord.com/api/v10/channels/thread-42/thread-members/@me",
          expect.objectContaining({ method: "PUT" }),
        );
        expect(lifecycle.closeDiscordThreadSessions).not.toHaveBeenCalled();
        if (reset === "archive") {
          await update(true);
          expect(fetch).toHaveBeenCalledOnce();
          expect(lifecycle.closeDiscordThreadSessions).toHaveBeenCalledWith({
            cfg: {},
            threadId: "thread-42",
          });
        } else {
          await client.dispatchGatewayEvent("READY", {});
        }
        newUpdate = update();
        await vi.waitFor(() => expect(client.getRuntimeMetrics().eventQueue?.processing).toBe(2));
        oldResponse.resolve();
        await Promise.all([oldUpdate, newUpdate]);
        await update();
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        oldResponse.resolve();
        await Promise.all([oldUpdate, newUpdate]);
      }
    },
  );

  it("keeps membership claims independent for two account clients", async () => {
    const first = createHarness({ accountId: "account-a" });
    const second = createHarness({ accountId: "account-b" });
    try {
      await first.update();
      await second.update();
      await first.client.dispatchGatewayEvent("READY", {});
      await first.update();
      await second.update();
      expect(first.fetch).toHaveBeenCalledTimes(2);
      expect(second.fetch).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([first.cleanup(), second.cleanup()]);
    }
  });

  it("unbinds the account's deleted thread and reports a session-close failure without farewell", async () => {
    const { client, fetch, logger } = createHarness();
    lifecycle.closeDiscordThreadSessions.mockRejectedValueOnce(new Error("session close failed"));
    await client.dispatchGatewayEvent("THREAD_DELETE", thread(false));
    expect(lifecycle.getThreadBindingManager).toHaveBeenCalledWith("work");
    expect(lifecycle.unbindThread).toHaveBeenCalledWith({
      threadId: "thread-42",
      reason: "thread-delete",
      sendFarewell: false,
    });
    expect(lifecycle.closeDiscordThreadSessions).toHaveBeenCalledWith({
      cfg: {},
      threadId: "thread-42",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("discord thread-delete handler failed"),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("Discord guild join introductions", () => {
  it.each(["permission", "report"] as const)(
    "retires introductions during %s work",
    async (stage) => {
      const permission = pause(async () => true);
      const report = pause(async () => ({ kind: "posted" as const }));
      if (stage === "permission") {
        mocks.canViewDiscordGuildChannel.mockImplementationOnce(permission.run);
      } else {
        mocks.reportChannelRoomJoin.mockImplementationOnce(report.run);
      }
      const blocked = stage === "permission" ? permission : report;
      const { joinGuild, cleanup, dispose } = createHarness({
        groupPolicy: "open",
        guildEntries: undefined,
      });
      const pending = joinGuild();
      await blocked.entered;
      const cleaned = vi.fn();
      const stopped = cleanup().then(cleaned);
      try {
        if (stage === "report") {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(cleaned).not.toHaveBeenCalled();
          expect(dispose).not.toHaveBeenCalled();
        } else {
          await stopped;
          expect(dispose).toHaveBeenCalledOnce();
        }
        await joinGuild();
      } finally {
        blocked.resolve();
        await Promise.all([pending, stopped]);
      }
      expect(mocks.reportChannelRoomJoin).toHaveBeenCalledTimes(stage === "permission" ? 0 : 1);
      expect(cleaned).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("ignores stale guild-create startup snapshots", async () => {
    const { client, cleanup } = createHarness();
    try {
      await client.dispatchGatewayEvent("GUILD_CREATE", {
        ...guildCreateEvent(),
        joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("introduces the bot in the permitted system channel using readable room context", async () => {
    mocks.readMessagesDiscord.mockResolvedValue([
      {
        content: "Newest deployment",
        author: { username: "casey", global_name: "Casey" },
      } as APIMessage,
      { content: "Older rollout", author: { username: "alex", global_name: null } } as APIMessage,
    ]);

    await createHarness().joinGuild();

    expect(reportChannelRoomJoin).toHaveBeenCalledOnce();
    const params = vi.mocked(reportChannelRoomJoin).mock.calls[0]?.[0];
    expect(params).toMatchObject({
      channel: "discord",
      accountId: "work",
      conversationId: "guild-1",
      deliverTo: "channel:system-channel",
      roomAllowed: true,
    });
    const options = expect.objectContaining({ accountId: "work" });
    expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledWith(
      "guild-1",
      "system-channel",
      "bot-1",
      options,
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "system-channel",
      "bot-1",
      [PermissionFlagsBits.SendMessages],
      options,
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
    const permission = pause(async () => true);
    mocks.canViewDiscordGuildChannel.mockImplementationOnce(permission.run);
    const { joinGuild } = createHarness({ cfg, readPolicy });
    const pending = joinGuild();
    await permission.entered;
    cfg = { channels: { discord: { groupPolicy: "disabled", guilds: {} } } };
    permission.resolve();
    await pending;
    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    await joinGuild();
    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ roomAllowed: false }),
    );
  });

  it("skips a writable policy-denied system channel for an allowed fallback", async () => {
    await createHarness({
      guildEntries: {
        "guild-1": { channels: { "fallback-channel": { enabled: true } } },
      },
    }).joinGuild();

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:fallback-channel", roomAllowed: true }),
    );
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledTimes(2);
  });

  it("passes actual guild and channel admission to the core instead of sender authorization", async () => {
    await createHarness({
      guildEntries: {
        "different-guild": { channels: { "system-channel": { enabled: true } } },
      },
    }).joinGuild();

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: "channel:system-channel", roomAllowed: false }),
    );
  });

  it("skips a guild with no writable text destination", async () => {
    mocks.canViewDiscordGuildChannel.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.hasAnyChannelPermissionDiscord.mockResolvedValue(false);
    const { joinGuild, logger } = createHarness();
    await joinGuild();

    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    expect(mocks.hasAnyChannelPermissionDiscord).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });
});

describe("DiscordPresenceListener", () => {
  it("retries when the queue rejects an event", async () => {
    mocks.enqueueSystemEvent.mockReturnValueOnce(false);
    const store = cooldownStore();
    const registerIfAbsent = vi.spyOn(store, "registerIfAbsent");
    const listener = createPresenceListener({
      presenceEvents: { burstLimit: 1 },
      cooldownStore: store,
    });

    await listener.handle(presence("offline"), humanClient);
    await listener.handle(presence("online"), humanClient);

    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    await listener.handle(presence("online"), humanClient);

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(2);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
    expect(registerIfAbsent).toHaveBeenCalledTimes(2);
    const route = { agentId: "molty", sessionKey: "agent:molty:discord:channel:channel-1" };
    const destination = { to: "channel:channel-1", accountId: "molty" };
    expect(mocks.enqueueSystemEvent).toHaveBeenLastCalledWith(
      expect.stringContaining('user_id="user-1"'),
      expect.objectContaining({
        ...route,
        deliveryContext: { ...destination, channel: "discord" },
      }),
    );
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ ...route, heartbeat: { ...destination, target: "discord" } }),
    );
  });

  it.each(["lookup", "permission", "claim"] as const)(
    "rejects replaced policy after awaiting %s",
    async (stage) => {
      let policy = livePresencePolicy(["user-1"]);
      const store = cooldownStore();
      const listener = createPresenceListener({
        cooldownStore: store,
        readPolicy: async () => {
          const current = policy;
          return { ...current, isCurrent: () => current === policy };
        },
      });
      await listener.handle(presence("offline"), humanClient);
      const pauses = {
        lookup: pause(store.lookup),
        claim: pause(store.registerIfAbsent),
        permission: pause(async () => true),
      };
      if (stage === "lookup") {
        vi.spyOn(store, "lookup").mockImplementationOnce(pauses.lookup.run);
      } else if (stage === "claim") {
        vi.spyOn(store, "registerIfAbsent").mockImplementationOnce(pauses.claim.run);
      } else {
        mocks.canViewDiscordGuildChannel.mockImplementationOnce(pauses.permission.run);
      }
      const event = listener.handle(presence("online"), humanClient);
      try {
        await pauses[stage].entered;
        expectWake();
        policy = livePresencePolicy(["user-2"], "channel-2");
      } finally {
        pauses[stage].resolve();
        await event;
      }
      expectWake();
      expect(await store.entries()).toEqual([]);
      await listener.handle(presence("online"), humanClient);
      expectWake();
      await listener.handle(presence("offline", "user-2"), humanClient);
      await listener.handle(presence("online", "user-2"), humanClient);
      expectWake("user-2");
      expect(mocks.enqueueSystemEvent.mock.lastCall?.[1]).toMatchObject({
        deliveryContext: { to: "channel:channel-2" },
      });
    },
  );

  it("drains reset-detached rollback without deleting a replacement cooldown", async () => {
    const values = new Map<string, number>();
    const store = cooldownStore(values);
    const listener = createPresenceListener({ cooldownStore: store });
    await listener.handle(presence("offline"), humanClient);
    const claim = pause(store.registerIfAbsent);
    vi.spyOn(store, "registerIfAbsent").mockImplementationOnce(claim.run);
    const rollback = pause(store.deleteIfEqual);
    vi.spyOn(store, "deleteIfEqual").mockImplementationOnce(rollback.run);
    const event = listener.handle(presence("online"), humanClient);
    const stopped = vi.fn();
    let stopping: Promise<void> | undefined;
    try {
      await claim.entered;
      listener.resetGatewaySession();
      stopping = listener.stop().then(stopped);
      claim.resolve();
      await rollback.entered;
      values.set("molty:guild-1:user-1", nowMs + 1);
      expect(stopped).not.toHaveBeenCalled();
      await listener.handle(presence("online", "late-user"), humanClient);
      expectWake();
    } finally {
      claim.resolve();
      rollback.resolve();
      await Promise.all([event, stopping]);
    }
    expect(stopped).toHaveBeenCalledOnce();
    expect(await store.lookup("molty:guild-1:user-1")).toBe(nowMs + 1);
    expectWake();
  });

  it("caches snapshot activities even when presence events are disabled", async () => {
    const listener = createPresenceListener({ presenceEvents: { enabled: false } });
    const snapshotPresence = {
      ...presence("online"),
      activities: [{ id: "activity-1", name: "Chess", type: 0, created_at: 0 }],
    };
    await listener.seedGuildSnapshot(guildSnapshot([snapshotPresence]));
    expect(getPresence("molty", "user-1")).toEqual(snapshotPresence);
    expect(getPresence("other-account", "user-1")).toBeUndefined();
    expectWake();
  });

  it.each([false, true])(
    "preserves snapshot/update dispatch order across a policy read (READY: %s)",
    async (reset) => {
      const policy = livePresencePolicy(["user-1", "already-online"]);
      const ready = createDeferred<DiscordLivePolicy>();
      const readPolicy = vi.fn().mockReturnValueOnce(ready.promise).mockResolvedValue(policy);
      const listener = createPresenceListener({ readPolicy });
      const seed = listener.seedGuildSnapshot(
        guildSnapshot([
          presence("offline"),
          presence("online", "already-online"),
          presence("online", "excluded"),
        ]),
      );
      expect(getPresence("molty", "user-1")?.status).toBe("offline");
      const event = listener.handle(presence("online"), humanClient);
      const existing = listener.handle(presence("online", "already-online"), humanClient);
      expect(getPresence("molty", "user-1")?.status).toBe("online");
      expectWake();
      ready.resolve(policy);
      if (reset) {
        // READY runs after policy resolution, before pending updates can resume.
        await ready.promise;
        listener.resetGatewaySession();
      }
      await Promise.all([seed, event, existing]);
      expect(getPresence("molty", "user-1")?.status).toBe(reset ? undefined : "online");
      expect(getPresence("molty", "excluded")?.status).toBe(reset ? undefined : "online");
      expectWake(...(reset ? [] : ["user-1"]));
    },
  );

  it("keeps complete snapshot inference isolated per guild", async () => {
    const listener = createPresenceListener({
      guildEntries: {
        "guild-1": { presenceEvents: { channelId: "channel-1" } },
        "guild-2": { presenceEvents: { channelId: "channel-1" } },
      },
      presenceBaseline: new DiscordPresenceBaselineCache(1),
    });

    await listener.seedGuildSnapshot(guildSnapshot([]));
    await listener.seedGuildSnapshot({ ...guildSnapshot([], 75_001), id: "guild-2" });
    await listener.handle({ ...presence("online", "busy-1"), guild_id: "guild-2" }, humanClient);
    await listener.handle({ ...presence("online", "busy-2"), guild_id: "guild-2" }, humanClient);
    await listener.handle(presence("online", "quiet-arrival"), humanClient);

    expectWake("quiet-arrival");
  });

  it("detaches stale lookups after a new gateway session", async () => {
    const listener = createPresenceListener({ presenceEvents: { reconnectSuppressSeconds: 0 } });
    const oldLookup = pause(async () => ({ bot: false }));
    const newLookup = pause(async () => ({ bot: false }));
    const fetchUser = vi
      .fn()
      .mockImplementationOnce(oldLookup.run)
      .mockImplementationOnce(newLookup.run);
    const lookupClient = presenceClient(fetchUser);
    await listener.seedGuildSnapshot(guildSnapshot([]));
    const stale = listener.handle(presence("online"), lookupClient);
    await oldLookup.entered;
    listener.resetGatewaySession();
    await listener.seedGuildSnapshot({ id: "guild-1", unavailable: true });
    await listener.seedGuildSnapshot(guildSnapshot([]));
    const current = listener.handle(presence("online"), lookupClient);
    try {
      await newLookup.entered;
      newLookup.resolve();
      await current;
    } finally {
      oldLookup.resolve();
      newLookup.resolve();
      await Promise.all([stale, current]);
    }
    expectWake("user-1");
  });

  it("invalidates in-flight work when Discord deletes a guild", async () => {
    const listener = createPresenceListener();
    const lookup = pause(async () => ({ bot: false }));
    await listener.seedGuildSnapshot(guildSnapshot([]));
    const pending = listener.handle(presence("online"), presenceClient(lookup.run));
    try {
      await lookup.entered;
      new DiscordPresenceGuildDeleteListener(listener).handle({ id: "guild-1" });
    } finally {
      lookup.resolve();
      await pending;
    }
    expectWake();
  });

  it("keeps transition state per guild and does not charge partial bots to the burst limit", async () => {
    const store = cooldownStore();
    const registerIfAbsent = vi.spyOn(store, "registerIfAbsent");
    const listener = createPresenceListener({
      presenceEvents: { burstLimit: 1 },
      cooldownStore: store,
    });
    const fetchUser = vi.fn(async () => ({ bot: true }));
    const botClient = presenceClient(fetchUser);

    await listener.handle({ ...presence("online"), guild_id: "guild-2" }, botClient);
    await listener.handle(presence("offline"), botClient);
    await listener.handle(presence("online"), botClient);
    await listener.handle(presence("offline", "human-1"), presenceClient());
    await listener.handle(presence("online", "human-1"), presenceClient());

    expect(fetchUser).toHaveBeenCalledWith("user-1");
    expectWake("human-1");
    expect(registerIfAbsent).toHaveBeenCalledTimes(1);
  });

  it("suppresses the presence replay burst after a gateway reconnect", async () => {
    const info = vi.fn();
    const listener = createPresenceListener({
      logger: { info } as never,
    });

    listener.resetGatewaySession();
    await listener.seedGuildSnapshot(guildSnapshot([]));
    await listener.handle(presence("online", "replayed-1"), humanClient);
    await listener.handle(presence("online", "replayed-2"), humanClient);

    expectWake();
    expect(info).toHaveBeenCalledTimes(1);

    // Post-window: replayed members stay marked online; a fresh transition emits.
    nowMs += 5 * 60 * 1000;
    await listener.handle(presence("online", "replayed-1"), humanClient);
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    await listener.handle(presence("offline", "replayed-1"), humanClient);
    await listener.handle(presence("online", "replayed-1"), humanClient);
    expectWake("replayed-1");
  });

  it.each(["pending", "committed"] as const)(
    "holds burst admission through a delayed permission lookup (%s)",
    async (phase) => {
      const permission = pause(async () => phase === "committed");
      mocks.canViewDiscordGuildChannel.mockImplementationOnce(permission.run);
      const store = cooldownStore();
      const listener = createPresenceListener({
        presenceEvents: { burstLimit: 1, burstWindowSeconds: 60 },
        cooldownStore: store,
      });
      await listener.seedGuildSnapshot(guildSnapshot([]));
      const first = listener.handle(presence("online", "first"), humanClient);
      try {
        await permission.entered;
        nowMs += 61_000;
        if (phase === "pending") {
          await listener.handle(presence("online", "eligible"), humanClient);
          expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledOnce();
          expectWake();
        }
      } finally {
        permission.resolve();
        await first;
      }
      if (phase === "pending") {
        expect(await store.entries()).toEqual([]);
      }
      await listener.handle(presence("online", "eligible"), humanClient);
      expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledTimes(phase === "pending" ? 2 : 1);
      expectWake(phase === "pending" ? "eligible" : "first");
    },
  );

  it.each(["user", "cooldown"] as const)("retries after a transient %s failure", async (stage) => {
    const store = cooldownStore();
    const logger = createSubsystemLogger("discord/test-presence");
    const log = vi.spyOn(logger, stage === "user" ? "error" : "warn").mockImplementation(() => {});
    const listener = createPresenceListener({ cooldownStore: store, logger });
    await listener.handle(presence("offline"), humanClient);
    const fetchUser = vi.spyOn(humanClient, "fetchUser");
    if (stage === "user") {
      fetchUser.mockRejectedValueOnce(new Error("temporary"));
    } else {
      vi.spyOn(store, "registerIfAbsent").mockRejectedValueOnce(new Error("capacity"));
    }
    await listener.handle(presence("online"), humanClient);
    expectWake();
    expect(log).toHaveBeenCalledOnce();
    await listener.handle(presence("online"), humanClient);
    expectWake("user-1");
    expect(fetchUser).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("shares one durable cooldown across overlapping and replacement listeners", async () => {
    const store = cooldownStore();
    const participants = [1, 2].map(() => ({
      listener: createPresenceListener({ cooldownStore: store }),
      lookup: pause(async () => ({ bot: false })),
    }));
    for (const { listener } of participants) {
      await listener.handle(presence("offline"), humanClient);
    }
    const pending = participants.map(({ listener, lookup }) =>
      listener.handle(presence("online"), presenceClient(lookup.run)),
    );
    try {
      await Promise.all(participants.map(({ lookup }) => lookup.entered));
    } finally {
      for (const { lookup } of participants) {
        lookup.resolve();
      }
      await Promise.all(pending);
    }
    expectWake("user-1");
    const replacement = createPresenceListener({ cooldownStore: store });
    nowMs += 30_000;
    await replacement.handle(presence("offline"), humanClient);
    await replacement.handle(presence("online"), humanClient);
    expectWake("user-1");
  });
});
