import {
  ChannelType,
  PermissionFlagsBits,
  type APIMessage,
  type GatewayGuildCreateDispatchData,
  type GatewayPresenceUpdate,
  PresenceUpdateStatus,
} from "discord-api-types/v10";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresenceStore as cooldownStore } from "../../../test-support/presence-store.js";
import { Client } from "../internal/discord.js";
import { DiscordPresenceGuildDeleteListener, DiscordPresenceListener } from "./listeners.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicy } from "./live-policy.js";
import { clearPresences, getPresence } from "./presence-cache.js";
import { DiscordPresenceBaselineCache } from "./presence-transition-cache.js";
import { registerDiscordMonitorListeners } from "./provider.startup.js";

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
  enqueueSessionEvent: vi.fn<PluginRuntime["system"]["enqueueSessionEvent"]>(() => ({
    id: "presence",
    cancel: () => false,
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
  })),
  captureSessionEventTarget: vi.fn(async () => Object.freeze({})),
  resolveAgentRoute: vi.fn(() => ({
    agentId: "molty",
    sessionKey: "agent:molty:discord:channel:channel-1",
  })),
  canViewDiscordGuildChannel: vi.fn(async () => true),
  hasAnyChannelPermissionDiscord: vi.fn(async () => true),
  readMessagesDiscord: vi.fn(async (): Promise<APIMessage[]> => []),
}));

const route = { agentId: "molty", sessionKey: "agent:molty:discord:channel:channel-1" };

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

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  getDiscordRuntime: () => ({
    system: {
      captureSessionEventTarget: mocks.captureSessionEventTarget,
      enqueueSessionEvent: mocks.enqueueSessionEvent,
    },
  }),
}));
vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: mocks.resolveAgentRoute,
}));
function thread(archived: boolean) {
  return { id: "thread-42", thread_metadata: { archived } };
}

function guildCreateEvent(): GatewayGuildCreateDispatchData {
  return {
    id: "guild-1",
    name: "OpenClaw Guild",
    joined_at: new Date().toISOString(),
    system_channel_id: "system-channel",
    channels: [
      { id: "fallback-channel", name: "fallback", type: ChannelType.GuildText },
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
  return { id: "guild-1", member_count: memberCount, presences } as GatewayGuildCreateDispatchData;
}

function presenceClient(fetchUser = async () => ({ bot: false })): Client {
  return { fetchUser: vi.fn(fetchUser) } as unknown as Client;
}

type PresenceListenerParams = ConstructorParameters<typeof DiscordPresenceListener>[0];
type PresenceEventConfig = NonNullable<
  NonNullable<PresenceListenerParams["guildEntries"]>[string]["presenceEvents"]
>;
type PresenceListenerOverrides = Partial<PresenceListenerParams> & {
  presenceEvents?: Partial<PresenceEventConfig>;
};
let nowMs = 1_000;
const cleanups: Array<() => Promise<void>> = [];

function createPresenceListener({ presenceEvents, ...overrides }: PresenceListenerOverrides = {}) {
  const store = overrides.cooldownStore ?? cooldownStore();
  const listener = new DiscordPresenceListener({
    cfg: {},
    accountId: "molty",
    guildEntries: {
      "guild-1": { presenceEvents: { channelId: "channel-1", ...presenceEvents } },
    },
    cooldownStore: store,
    nowMs: () => nowMs,
    ...overrides,
  });
  const send = (status: "online" | "offline", userId = "user-1", client = humanClient) =>
    listener.handle(presence(status, userId), client);
  return Object.assign(listener, {
    store,
    online: (userId?: string, client?: Client) => send("online", userId, client),
    offline: (userId?: string, client?: Client) => send("offline", userId, client),
    transition: async (userId?: string, client?: Client) => {
      await send("offline", userId, client);
      await send("online", userId, client);
    },
  });
}

function expectWake(...userIds: string[]) {
  expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(userIds.length);
  for (const userId of userIds) {
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
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
    during: async (pending: Promise<unknown>, check: () => void | Promise<void>) => {
      try {
        await entered.promise;
        await check();
      } finally {
        ready.resolve();
        await pending;
      }
    },
    run: async (...args: Args): Promise<Result> => {
      entered.resolve();
      await ready.promise;
      return await operation(...args);
    },
  };
}

function pausePresenceWork(
  store: PluginStateKeyedStore<number>,
  stage: "lookup" | "target" | "permission" | "claim",
) {
  if (stage === "target") {
    const blocked = pause(async () => Object.freeze({}));
    mocks.captureSessionEventTarget.mockImplementationOnce(blocked.run);
    return blocked;
  }
  if (stage === "permission") {
    const blocked = pause(async () => true);
    mocks.canViewDiscordGuildChannel.mockImplementationOnce(blocked.run);
    return blocked;
  }
  if (stage === "lookup") {
    const blocked = pause(store.lookup.bind(store));
    vi.spyOn(store, "lookup").mockImplementationOnce(blocked.run);
    return blocked;
  }
  const blocked = pause(store.registerIfAbsent.bind(store));
  vi.spyOn(store, "registerIfAbsent").mockImplementationOnce(blocked.run);
  return blocked;
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
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation(() => {});
  }
  const client = new Client(
    {
      clientId: "test-app",
      token: "test-token",
      requestOptions: { fetch },
      eventQueue: {},
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
  const joinGuild = (event: Partial<GatewayGuildCreateDispatchData> = {}) =>
    client.dispatchGatewayEvent("GUILD_CREATE", { ...guildCreateEvent(), ...event });
  cleanups.push(stopMonitorListeners);
  return { client, fetch, logger, onEvent, update, joinGuild, cleanup: stopMonitorListeners };
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
  mocks.resolveAgentRoute.mockReturnValue(route);
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe("Discord monitor dispatch", () => {
  it("tracks inbound messages before their handlers complete", async () => {
    const blocked = pause(async () => {});
    const { client, onEvent } = createHarness({ messageHandler: blocked.run });
    await blocked.during(
      client.dispatchGatewayEvent("MESSAGE_CREATE", { channel_id: "ch-1" }),
      () => {
        expect(onEvent).toHaveBeenCalledOnce();
      },
    );
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

  it("rejoins after an archived thread is reopened", async () => {
    const { fetch, update } = createHarness();
    await update();
    await update();
    expect(fetch).toHaveBeenCalledOnce();
    await update(true);
    expect(lifecycle.closeDiscordThreadSessions).toHaveBeenCalledWith({
      cfg: {},
      threadId: "thread-42",
    });
    await update();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps membership claims independent for two account clients", async () => {
    const first = createHarness({ accountId: "account-a" });
    const second = createHarness({ accountId: "account-b" });
    await first.update();
    await second.update();
    await first.client.dispatchGatewayEvent("READY", {});
    await first.update();
    await second.update();
    expect(first.fetch).toHaveBeenCalledTimes(2);
    expect(second.fetch).toHaveBeenCalledOnce();
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
      const { joinGuild, cleanup } = createHarness({
        groupPolicy: "open",
        guildEntries: undefined,
      });
      const pending = joinGuild();
      await blocked.entered;
      const cleaned = vi.fn();
      const stopped = cleanup().then(cleaned);
      await blocked.during(Promise.all([pending, stopped]), async () => {
        if (stage === "report") {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(cleaned).not.toHaveBeenCalled();
        } else {
          await stopped;
        }
        await joinGuild();
      });
      expect(mocks.reportChannelRoomJoin).toHaveBeenCalledTimes(stage === "permission" ? 0 : 1);
      expect(cleaned).toHaveBeenCalledOnce();
    },
  );

  it("ignores stale guild-create startup snapshots", async () => {
    await createHarness().joinGuild({
      joined_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
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
    await permission.during(joinGuild(), () => {
      cfg = { channels: { discord: { groupPolicy: "disabled", guilds: {} } } };
    });
    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    await joinGuild();
    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ roomAllowed: false }),
    );
  });

  it.each([
    ["guild-1", "fallback-channel", true],
    ["different-guild", "system-channel", false],
  ] as const)("routes guild introduction for %s to %s", async (guildId, channelId, roomAllowed) => {
    await createHarness({
      guildEntries: { [guildId]: { channels: { [channelId]: { enabled: true } } } },
    }).joinGuild();

    expect(reportChannelRoomJoin).toHaveBeenCalledWith(
      expect.objectContaining({ deliverTo: `channel:${channelId}`, roomAllowed }),
    );
  });

  it("skips a guild with no writable text destination", async () => {
    mocks.canViewDiscordGuildChannel.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.hasAnyChannelPermissionDiscord.mockResolvedValue(false);
    const { joinGuild, logger } = createHarness();
    await joinGuild();

    expect(reportChannelRoomJoin).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
  });
});

describe("DiscordPresenceListener", () => {
  it.each(["user", "cooldown", "enqueue", "acceptance"] as const)(
    "releases admission and retries after a transient %s failure",
    async (stage) => {
      const logger = createSubsystemLogger("discord/test-presence");
      const log = vi
        .spyOn(logger, stage === "user" || stage === "enqueue" ? "error" : "warn")
        .mockImplementation(() => {});
      const listener = createPresenceListener({ logger, presenceEvents: { burstLimit: 1 } });
      const claim = vi.spyOn(listener.store, "registerIfAbsent");
      const fetchUser = vi.spyOn(humanClient, "fetchUser");
      if (stage === "user") {
        fetchUser.mockRejectedValueOnce(new Error("temporary"));
      } else if (stage === "cooldown") {
        claim.mockRejectedValueOnce(new Error("capacity"));
      } else {
        mocks.enqueueSessionEvent.mockImplementationOnce(() => {
          if (stage === "enqueue") {
            throw new Error("session-event admission refused");
          }
          return {
            id: "refused",
            cancel: () => false,
            accepted: Promise.resolve({ ok: false, error: "session-event admission refused" }),
            settled: Promise.resolve({
              status: "failed",
              executionStarted: false,
              delivered: false,
            }),
          };
        });
      }
      await listener.transition();
      expect(log).toHaveBeenCalledOnce();
      expect(await listener.store.entries()).toEqual([]);
      const priorEnqueue = Number(stage === "enqueue" || stage === "acceptance");
      expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(priorEnqueue);
      await listener.online();
      expect(mocks.enqueueSessionEvent).toHaveBeenCalledTimes(priorEnqueue + 1);
      expect(mocks.enqueueSessionEvent).toHaveBeenLastCalledWith(
        expect.stringContaining('user_id="user-1"'),
        expect.objectContaining({
          ...route,
          expectedTarget: await mocks.captureSessionEventTarget.mock.results.at(-1)?.value,
          createIfMissing: true,
          deliveryContext: { to: "channel:channel-1", accountId: "molty", channel: "discord" },
        }),
      );
    },
  );

  it("pins the selected route before awaiting the cooldown lookup", async () => {
    const listener = createPresenceListener();
    await listener.offline();
    const lookup = pausePresenceWork(listener.store, "lookup");
    await lookup.during(listener.online(), () => {
      mocks.resolveAgentRoute.mockReturnValue({
        agentId: "replacement",
        sessionKey: "agent:replacement:discord:channel:channel-1",
      });
    });
    expect(mocks.captureSessionEventTarget).toHaveBeenCalledWith(route.agentId, route.sessionKey);
    expect(mocks.enqueueSessionEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining(route),
    );
  });

  it("returns after acceptance and reports failed settlement without retrying the greeting", async () => {
    type Receipt = ReturnType<PluginRuntime["system"]["enqueueSessionEvent"]>;
    const accepted = createDeferred<Awaited<Receipt["accepted"]>>();
    const settled = createDeferred<Awaited<Receipt["settled"]>>();
    const submitted = createDeferred<void>();
    mocks.enqueueSessionEvent.mockImplementationOnce(() => {
      submitted.resolve();
      return {
        id: "pending",
        cancel: () => false,
        accepted: accepted.promise,
        settled: settled.promise,
      };
    });
    const warn = vi.fn();
    const listener = createPresenceListener({ logger: { warn } as never });
    await listener.offline();
    const completed = vi.fn();
    const pending = listener.online().then(completed);
    await submitted.promise;
    expect(completed).not.toHaveBeenCalled();
    accepted.resolve({ ok: true });
    await pending;
    expect(warn).not.toHaveBeenCalled();
    settled.resolve({
      status: "failed",
      executionStarted: true,
      delivered: false,
      error: "delivery failed",
    });
    await settled.promise;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("delivery failed"));
    await listener.online();
    expectWake("user-1");
    expect(await listener.store.entries()).toHaveLength(1);
  });

  it.each(["target", "claim"] as const)(
    "rejects replaced policy after awaiting %s",
    async (stage) => {
      let policy = livePresencePolicy(["user-1"]);
      const listener = createPresenceListener({
        readPolicy: async () => {
          const current = policy;
          return { ...current, isCurrent: () => current === policy };
        },
      });
      const { store } = listener;
      await listener.offline();
      const blocked = pausePresenceWork(store, stage);
      await blocked.during(listener.online(), () => {
        expectWake();
        policy = livePresencePolicy(["user-2"], "channel-2");
      });
      expectWake();
      expect(await store.entries()).toEqual([]);
      await listener.online();
      expectWake();
      await listener.transition("user-2");
      expectWake("user-2");
      expect(mocks.enqueueSessionEvent.mock.lastCall?.[1]).toMatchObject({
        deliveryContext: { to: "channel:channel-2" },
      });
    },
  );

  it("drains admitted rollback during shutdown after a gateway reset", async () => {
    const listener = createPresenceListener();
    const { store } = listener;
    await listener.offline();
    const claim = pausePresenceWork(store, "claim");
    const deleteIfEqual = store.deleteIfEqual;
    if (!deleteIfEqual) {
      throw new Error("Expected conditional deletion in the presence fixture");
    }
    const rollback = pause(deleteIfEqual.bind(store));
    vi.spyOn(store, "deleteIfEqual").mockImplementationOnce(rollback.run);
    const event = listener.online();
    const stopped = vi.fn();
    let stopping: Promise<void> | undefined;
    try {
      await claim.entered;
      listener.resetGatewaySession();
      stopping = listener.stop().then(stopped);
      claim.resolve();
      await rollback.entered;
      expect(stopped).not.toHaveBeenCalled();
      await listener.online("late-user");
      expectWake();
    } finally {
      claim.resolve();
      rollback.resolve();
      await Promise.all([event, stopping]);
    }
    expect(stopped).toHaveBeenCalledOnce();
    expect(await store.lookup("molty:guild-1:user-1")).toBeUndefined();
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
      const event = listener.online();
      const existing = listener.online("already-online");
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

  it("preserves per-user FIFO across a new gateway session", async () => {
    const listener = createPresenceListener({ presenceEvents: { reconnectSuppressSeconds: 0 } });
    const oldLookup = pause(async () => ({ bot: false }));
    const fetchUser = vi.fn(oldLookup.run);
    const lookupClient = presenceClient(fetchUser);
    await listener.seedGuildSnapshot(guildSnapshot([]));
    const stale = listener.online("user-1", lookupClient);
    await oldLookup.entered;
    listener.resetGatewaySession();
    await listener.seedGuildSnapshot({ id: "guild-1", unavailable: true });
    await listener.seedGuildSnapshot(guildSnapshot([]));
    const current = listener.online("user-1", lookupClient);
    await oldLookup.during(Promise.all([stale, current]), async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(fetchUser).toHaveBeenCalledOnce();
      expectWake();
    });
    expectWake("user-1");
    expect(fetchUser).toHaveBeenCalledOnce();
  });

  it("invalidates in-flight work when Discord deletes a guild", async () => {
    const listener = createPresenceListener();
    const lookup = pause(async () => ({ bot: false }));
    await listener.seedGuildSnapshot(guildSnapshot([]));
    await lookup.during(listener.online("user-1", presenceClient(lookup.run)), () => {
      new DiscordPresenceGuildDeleteListener(listener).handle({ id: "guild-1" });
    });
    expectWake();
  });

  it("keeps transition state per guild and does not charge partial bots to the burst limit", async () => {
    const listener = createPresenceListener({ presenceEvents: { burstLimit: 1 } });
    const fetchUser = vi.fn(async () => ({ bot: true }));
    const botClient = presenceClient(fetchUser);

    await listener.handle({ ...presence("online"), guild_id: "guild-2" }, botClient);
    await listener.transition("user-1", botClient);
    await listener.transition("human-1");

    expect(fetchUser).toHaveBeenCalledWith("user-1");
    expectWake("human-1");
  });

  it.each(["before", "permission", "claim"] as const)(
    "suppresses replay when reconnect happens %s presence work",
    async (stage) => {
      const info = vi.fn();
      const listener = createPresenceListener({ logger: { info } as never });
      const { store } = listener;
      if (stage === "before") {
        listener.resetGatewaySession();
        await listener.seedGuildSnapshot(guildSnapshot([]));
        await listener.online("replayed-1");
      } else {
        const blocked = pausePresenceWork(store, stage);
        await listener.seedGuildSnapshot(guildSnapshot([]));
        await blocked.during(listener.online("replayed-1"), async () => {
          listener.resetGatewaySession();
          await listener.seedGuildSnapshot(guildSnapshot([]));
        });
      }
      await listener.online("replayed-2");

      expectWake();
      expect(info).toHaveBeenCalledTimes(1);

      // Post-window: replayed members stay marked online; a fresh transition emits.
      nowMs += 5 * 60 * 1000;
      await listener.online("replayed-1");
      expect(mocks.enqueueSessionEvent).not.toHaveBeenCalled();
      await listener.transition("replayed-1");
      expectWake("replayed-1");
    },
  );

  it.each(["pending", "committed"] as const)(
    "holds burst admission through a delayed permission lookup (%s)",
    async (phase) => {
      const permission = pause(async () => phase === "committed");
      mocks.canViewDiscordGuildChannel.mockImplementationOnce(permission.run);
      const listener = createPresenceListener({
        presenceEvents: { burstLimit: 1, burstWindowSeconds: 60 },
      });
      await listener.seedGuildSnapshot(guildSnapshot([]));
      await permission.during(listener.online("first"), async () => {
        nowMs += 61_000;
        if (phase === "pending") {
          await listener.online("eligible");
          expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledOnce();
          expectWake();
        }
      });
      if (phase === "pending") {
        expect(await listener.store.entries()).toEqual([]);
      }
      await listener.online("eligible");
      expect(mocks.canViewDiscordGuildChannel).toHaveBeenCalledTimes(phase === "pending" ? 2 : 1);
      expectWake(phase === "pending" ? "eligible" : "first");
    },
  );

  it("shares one durable cooldown across overlapping and replacement listeners", async () => {
    const store = cooldownStore();
    const participants = [1, 2].map(() => ({
      listener: createPresenceListener({ cooldownStore: store }),
      lookup: pause(async () => ({ bot: false })),
    }));
    for (const { listener } of participants) {
      await listener.offline();
    }
    const pending = participants.map(({ listener, lookup }) =>
      listener.online("user-1", presenceClient(lookup.run)),
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
    await replacement.transition();
    expectWake("user-1");
  });
});
