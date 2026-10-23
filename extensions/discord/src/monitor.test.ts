import { GatewayDispatchEvents } from "discord-api-types/v10";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import * as fixtures from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "./internal/discord.js";
import { mapGatewayDispatchData } from "./internal/gateway-dispatch.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordOwnerAccess,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./monitor/allow-list.js";
import { createDiscordLivePolicyReader } from "./monitor/live-policy.js";
import { resolveDiscordReplyTarget } from "./monitor/threading.js";
import { setDiscordRuntime } from "./runtime.js";
import { firstMockArg, firstMockCall } from "./test-support/mock-calls.js";
type DiscordReactionEvent = Parameters<
  import("./monitor/listeners.js").DiscordReactionListener["handle"]
>[0];
type DiscordReactionClient = Parameters<
  import("./monitor/listeners.js").DiscordReactionListener["handle"]
>[1];

const readAllowFromStoreMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  };
});

function expectNormalizedAllowList(
  entries: string[],
  prefixes: string[],
): NonNullable<ReturnType<typeof normalizeDiscordAllowList>> {
  const allow = normalizeDiscordAllowList(entries, prefixes);
  if (allow === null) {
    throw new Error("Expected allow list to be normalized");
  }
  return allow;
}

beforeEach(() => {
  setDiscordRuntime(createPluginRuntimeMock());
  vi.useRealTimers();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
});

describe("registerDiscordListener", () => {
  class FakeListener {
    readonly testListener = true;
  }

  it("dedupes listeners by constructor", () => {
    const listeners: object[] = [];

    expect(registerDiscordListener(listeners, new FakeListener())).toBe(true);
    expect(registerDiscordListener(listeners, new FakeListener())).toBe(false);
    expect(listeners).toHaveLength(1);
  });
});

describe("DiscordMessageListener", () => {
  const messageEvent = {} as Parameters<InstanceType<typeof DiscordMessageListener>["handle"]>[0];
  const messageClient = {} as import("./internal/discord.js").Client;
  async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("waits for the durable handler handoff", async () => {
    let handlerResolved = false;
    const deferred = createDeferred<void>();
    const handler = vi.fn(async () => {
      await deferred.promise;
      handlerResolved = true;
    });
    const listener = new DiscordMessageListener(handler);

    const handlePromise = listener.handle(messageEvent, messageClient);

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledOnce();
    expect(handlerResolved).toBe(false);

    deferred.resolve();
    await expect(handlePromise).resolves.toBeUndefined();
    expect(handlerResolved).toBe(true);
  });

  it("dispatches subsequent events concurrently without blocking on prior handler", async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    let runCount = 0;
    const handler = vi.fn(async () => {
      runCount += 1;
      if (runCount === 1) {
        await first.promise;
        return;
      }
      await second.promise;
    });
    const listener = new DiscordMessageListener(handler);

    const firstHandle = listener.handle(messageEvent, messageClient);
    const secondHandle = listener.handle(messageEvent, messageClient);

    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);

    first.resolve();
    second.resolve();
    await Promise.all([firstHandle, secondHandle]);
  });

  it("logs handler failures", async () => {
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >;
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const listener = new DiscordMessageListener(handler, logger);

    await listener.handle(messageEvent, messageClient);
    await flushAsyncWork();
    expect(logger.error).toHaveBeenCalledWith(danger("discord handler failed: Error: boom"));
  });
});

describe("discord allowlist helpers", () => {
  it("matches ids by default and names only when enabled", () => {
    const allow = expectNormalizedAllowList(
      ["123", "steipete", "Friends of OpenClaw"],
      ["discord:", "user:", "guild:", "channel:"],
    );
    expect(allowListMatches(allow, { id: "123" }, { allowNameMatching: false })).toBe(true);
    expect(allowListMatches(allow, { name: "steipete" }, { allowNameMatching: false })).toBe(false);
    expect(
      allowListMatches(allow, { name: "friends-of-openclaw" }, { allowNameMatching: false }),
    ).toBe(false);
    expect(allowListMatches(allow, { name: "steipete" }, { allowNameMatching: true })).toBe(true);
    expect(
      allowListMatches(allow, { name: "friends-of-openclaw" }, { allowNameMatching: true }),
    ).toBe(true);
    expect(allowListMatches(allow, { name: "other" }, { allowNameMatching: false })).toBe(false);
  });

  it("does not treat DM wildcard access as owner access", () => {
    const wildcardOnly = resolveDiscordOwnerAccess({
      allowFrom: ["*"],
      sender: { id: "123" },
    });
    expect(wildcardOnly).toEqual({ ownerAllowList: null, ownerAllowed: false });

    const explicitOwner = resolveDiscordOwnerAccess({
      allowFrom: ["*", "user:123"],
      sender: { id: "123" },
    });
    expect(explicitOwner).toMatchObject({
      ownerAllowList: { allowAll: false },
      ownerAllowed: true,
    });
    expect(explicitOwner.ownerAllowList?.ids).toEqual(new Set(["123"]));
  });
});

describe("discord guild/channel resolution", () => {
  it("denies channel when config present but no match", () => {
    const channel = resolveDiscordChannelConfig({
      guildInfo: { channels: { general: { enabled: true } } },
      channelId: "999",
      channelName: "random",
      channelSlug: "random",
    });
    expect(channel?.allowed).toBe(false);
  });

  it("does not match thread name/slug when resolving allowlists", () => {
    const thread = resolveDiscordChannelConfigWithFallback({
      guildInfo: { channels: { general: { enabled: true }, random: { enabled: false } } },
      channelId: "thread-999",
      channelName: "general",
      channelSlug: "general",
      parentId: "999",
      parentName: "random",
      parentSlug: "random",
      scope: "thread",
    });
    expect(thread?.allowed).toBe(false);
  });

  it("falls back to wildcard when thread channel and parent are missing", () => {
    const thread = resolveDiscordChannelConfigWithFallback({
      guildInfo: { channels: { "*": { enabled: true, requireMention: false } } },
      channelId: "thread-123",
      channelName: "topic",
      channelSlug: "topic",
      parentId: "parent-999",
      parentName: "general",
      parentSlug: "general",
      scope: "thread",
    });
    expect(thread).toMatchObject({ allowed: true, matchKey: "*", matchSource: "wildcard" });
  });
});

it("discord groupPolicy gating: applies open/disabled/allowlist policy rules", () => {
  const cases = [
    ["open", "open", false, false, false, true],
    ["disabled", "disabled", true, true, true, false],
    ["guild denied", "allowlist", false, false, true, false],
    ["no channel restriction", "allowlist", true, false, true, true],
    ["channel allowed", "allowlist", true, true, true, true],
    ["channel denied", "allowlist", true, true, false, false],
  ] as const;

  for (const [
    name,
    groupPolicy,
    guildAllowlisted,
    channelAllowlistConfigured,
    channelAllowed,
    expected,
  ] of cases) {
    expect(
      isDiscordGroupAllowedByPolicy({
        groupPolicy,
        guildAllowlisted,
        channelAllowlistConfigured,
        channelAllowed,
      }),
      name,
    ).toBe(expected);
  }
});

it("discord group DM gating: matches group DM allowlist", () => {
  for (const [channelName, channelSlug, allowed] of [
    ["OpenClaw DM", "openclaw-dm", true],
    ["Other", "other", false],
  ] as const) {
    expect(
      resolveGroupDmAllow({ channels: ["openclaw-dm"], channelId: "1", channelName, channelSlug }),
    ).toBe(allowed);
  }
});

it("discord reply target selection: handles off/first/all reply modes", () => {
  const cases = [
    ["off mode", "off", false, undefined],
    ["first before reply", "first", false, "123"],
    ["first after reply", "first", true, undefined],
    ["all before reply", "all", false, "123"],
    ["all after reply", "all", true, "123"],
  ] as const;

  for (const [name, replyToMode, hasReplied, expected] of cases) {
    expect(resolveDiscordReplyTarget({ replyToMode, replyToId: "123", hasReplied }), name).toBe(
      expected,
    );
  }
});

it("discord reaction notification gating: applies mode-specific reaction notification rules", () => {
  type Input = Omit<Parameters<typeof shouldEmitDiscordReactionNotification>[0], "botId">;
  const outsider = { users: ["trusted-user"] };
  const namedUser = {
    mode: "allowlist" as const,
    userId: "999",
    userName: "trusted-user",
    guildInfo: outsider,
  };
  const cases: Array<[string, Partial<Input>, boolean]> = [
    ["unset own, bot author", { messageAuthorId: "bot-1", userId: "user-1" }, true],
    ["unset own, other author", {}, false],
    ["off", { mode: "off", messageAuthorId: "bot-1", userId: "user-1" }, false],
    ["all", { mode: "all" }, true],
    ["all blocks outsider", { mode: "all", guildInfo: outsider }, false],
    ["own, bot author", { mode: "own", messageAuthorId: "bot-1" }, true],
    ["own, other author", { mode: "own", messageAuthorId: "user-2", userId: "user-3" }, false],
    [
      "own blocks outsider",
      {
        mode: "own",
        messageAuthorId: "bot-1",
        userId: "user-3",
        guildInfo: outsider,
      },
      false,
    ],
    ["allowlist misses", { mode: "allowlist", guildInfo: { users: [] } }, false],
    [
      "allowlist id",
      {
        mode: "allowlist",
        userId: "123",
        userName: "steipete",
        guildInfo: { users: ["123", "other"] },
      },
      true,
    ],
    ["allowlist names disabled", namedUser, false],
    ["allowlist names enabled", { ...namedUser, allowNameMatching: true }, true],
    [
      "allowlist role",
      {
        mode: "allowlist",
        userId: "999",
        guildInfo: { roles: ["role:trusted-role"] },
        memberRoleIds: ["trusted-role"],
      },
      true,
    ],
  ];

  for (const [name, input, expected] of cases) {
    expect(
      shouldEmitDiscordReactionNotification({
        botId: "bot-1",
        messageAuthorId: "user-1",
        userId: "user-2",
        ...input,
      }),
      name,
    ).toBe(expected);
  }
});

const { enqueueSystemEventSpy, resolveAgentRouteMock } = vi.hoisted(() => ({
  enqueueSystemEventSpy: vi.fn(),
  resolveAgentRouteMock: vi.fn((params: unknown) => ({
    agentId: "default",
    channel: "discord",
    accountId: "acc-1",
    sessionKey: "discord:acc-1:dm:user-1",
    mainSessionKey: "discord:acc-1:dm:user-1",
    lastRoutePolicy: "session" as const,
    matchedBy: "default" as const,
    ...(typeof params === "object" && params !== null ? { _params: params } : {}),
  })),
}));

const channelRuntimeModule = await import("openclaw/plugin-sdk/system-event-runtime");
vi.spyOn(channelRuntimeModule, "enqueueRoutedSystemEvent").mockImplementation(
  (text, route, options) =>
    enqueueSystemEventSpy(text, { ...options, sessionKey: route.sessionKey }) as boolean,
);

const routingModule = await import("openclaw/plugin-sdk/routing");
vi.spyOn(routingModule, "resolveAgentRoute").mockImplementation(resolveAgentRouteMock);

const {
  DiscordMessageListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
  registerDiscordListener,
} = await import("./monitor/listeners.js");

const requireRecord = fixtures.createRequireRecord("object", "expected-label-object");

function makeReactionEvent(overrides?: {
  guildId?: string;
  channelId?: string;
  userId?: string;
  username?: string;
  messageId?: string;
  emojiName?: string;
  botAsAuthor?: boolean;
  messageAuthorId?: string;
  messageFetch?: ReturnType<typeof vi.fn>;
  guild?: { name?: string; id?: string };
  memberRoleIds?: string[];
}) {
  const userId = overrides?.userId ?? "user-1";
  const messageId = overrides?.messageId ?? "1001";
  const channelId = overrides?.channelId ?? "channel-1";
  const messageFetch =
    overrides?.messageFetch ??
    vi.fn(async () => ({
      author: {
        id: overrides?.messageAuthorId ?? (overrides?.botAsAuthor ? "bot-1" : "other-user"),
        username: overrides?.botAsAuthor ? "bot" : "otheruser",
        discriminator: "0",
      },
    }));
  return {
    guild_id: overrides?.guildId,
    channel_id: channelId,
    message_id: messageId,
    emoji: { name: overrides?.emojiName ?? "👍", id: null },
    guild: overrides?.guild,
    rawMember: overrides?.memberRoleIds ? { roles: overrides.memberRoleIds } : undefined,
    user: {
      id: userId,
      bot: false,
      username: overrides?.username ?? "testuser",
      discriminator: "0",
    },
    message: { fetch: messageFetch },
  } as unknown as DiscordReactionEvent;
}

function makeReactionClient(options?: {
  channelType?: ChannelType;
  channelName?: string;
  parentId?: string;
  parentName?: string;
}) {
  const channelType = options?.channelType ?? ChannelType.DM;
  const channelName =
    options?.channelName ?? (channelType === ChannelType.DM ? undefined : "test-channel");
  const parentId = options?.parentId;
  const parentName = options?.parentName ?? "parent-channel";

  return {
    fetchChannel: vi.fn(async (channelId: string) => {
      if (parentId && channelId === parentId) {
        return { type: ChannelType.GuildText, name: parentName, parentId: undefined };
      }
      return { type: channelType, name: channelName, parentId };
    }),
  } as unknown as DiscordReactionClient;
}

function getReactionClientFetchChannelMock(client: DiscordReactionClient) {
  return (client as unknown as { fetchChannel: ReturnType<typeof vi.fn> }).fetchChannel;
}

function makeReactionListenerParams(
  overrides: Partial<ConstructorParameters<typeof DiscordReactionListener>[0]> = {},
) {
  return {
    cfg: {} as OpenClawConfig,
    accountId: "acc-1",
    runtime: {} as import("openclaw/plugin-sdk/runtime-env").RuntimeEnv,
    botUserId: "bot-1",
    dmEnabled: true,
    groupDmEnabled: true,
    groupDmChannels: [],
    dmPolicy: "open" as const,
    allowFrom: ["*"],
    groupPolicy: "open" as const,
    allowNameMatching: false,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ReturnType<
      typeof import("openclaw/plugin-sdk/logging-core").createSubsystemLogger
    >,
    ...overrides,
  };
}

async function handleReaction(
  params: Parameters<typeof makeReactionListenerParams>[0] = {},
  event: Parameters<typeof makeReactionEvent>[0] = {},
  channelType = ChannelType.DM,
) {
  const data = makeReactionEvent({ botAsAuthor: true, ...event });
  const client = makeReactionClient({ channelType });
  const listener = new DiscordReactionListener(makeReactionListenerParams(params));
  await listener.handle(data, client);
  return client;
}

describe("discord DM reaction handling", () => {
  beforeEach(() => {
    enqueueSystemEventSpy.mockClear();
    resolveAgentRouteMock.mockClear();
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  });

  it("processes DM reactions with or without guild allowlists", async () => {
    const cases = [
      { name: "no guild allowlist", guildEntries: undefined },
      {
        name: "guild allowlist configured",
        guildEntries: {
          "guild-123": { slug: "guild-123" },
        },
      },
    ] as const;

    for (const testCase of cases) {
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      await handleReaction({ guildEntries: testCase.guildEntries });

      expect(enqueueSystemEventSpy, testCase.name).toHaveBeenCalledOnce();
      const [text, opts] = firstMockCall(enqueueSystemEventSpy, "enqueueSystemEvent");
      expect(text, testCase.name).toContain("Discord reaction added");
      expect(text, testCase.name).toContain("👍");
      expect(text, testCase.name).toContain("dm");
      expect(text, testCase.name).not.toContain("undefined");
      expect(requireRecord(opts, "system event options").sessionKey, testCase.name).toBe(
        "discord:acc-1:dm:user-1",
      );
    }
  });

  it("keeps the actor id when a reaction removal does not include a Discord username", async () => {
    const data = makeReactionEvent({ userId: "user-42", username: "", botAsAuthor: true });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    const listener = new DiscordReactionRemoveListener(makeReactionListenerParams());

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
    const text = firstMockArg(enqueueSystemEventSpy, "enqueueSystemEvent");
    expect(text).toContain("Discord reaction removed: 👍 by user-42 on");
  });

  it.each([
    {
      action: "added",
      event: GatewayDispatchEvents.MessageReactionAdd,
      Listener: DiscordReactionListener,
    },
    {
      action: "removed",
      event: GatewayDispatchEvents.MessageReactionRemove,
      Listener: DiscordReactionRemoveListener,
    },
  ])("preserves distinct normal and super reactions when $action", async (testCase) => {
    fixtures.resetSystemEventsForTest();
    const params = makeReactionListenerParams();
    setRuntimeConfigSnapshot(params.cfg);
    enqueueSystemEventSpy.mockImplementation((text: string, options: { sessionKey: string }) =>
      channelRuntimeModule.enqueueSystemEvent(text, options),
    );

    try {
      const fetchMessage = vi.fn(async () => ({
        id: "1001",
        channel_id: "channel-1",
        author: { id: "bot-1", username: "bot", discriminator: "0" },
      }));
      const client = Object.assign(
        makeReactionClient({ channelType: ChannelType.GuildText, channelName: "general" }),
        { rest: { get: fetchMessage } },
      );
      const listener = new testCase.Listener(params);
      const gatewayEvent = {
        user_id: "user-1",
        channel_id: "channel-1",
        message_id: "1001",
        guild_id: "guild-123",
        emoji: { id: null, name: "👍" },
        ...(testCase.action === "added"
          ? { member: { user: { id: "user-1", username: "actor", discriminator: "0" }, roles: [] } }
          : {}),
      };

      for (const reaction of [
        { burst: false, type: 0 },
        { burst: true, type: 1 },
        { burst: false, type: 0 },
        { burst: true, type: 1 },
      ]) {
        await listener.handle(
          mapGatewayDispatchData(client, testCase.event, {
            ...gatewayEvent,
            ...reaction,
          }) as DiscordReactionEvent,
          client,
        );
      }

      const events = channelRuntimeModule.peekSystemEventEntries("discord:acc-1:dm:user-1");
      const actor = testCase.action === "added" ? "actor" : "user-1";
      expect(events.map(({ text, contextKey }) => ({ text, contextKey }))).toEqual([
        {
          text: `Discord reaction ${testCase.action}: 👍 by ${actor} on guild-123 #general msg 1001 from bot`,
          contextKey: `discord:reaction:${testCase.action}:1001:user-1:👍`,
        },
        {
          text: `Discord super reaction ${testCase.action}: 👍 by ${actor} on guild-123 #general msg 1001 from bot`,
          contextKey: `discord:reaction:${testCase.action}:1001:user-1:👍:burst`,
        },
      ]);
      expect(fetchMessage).toHaveBeenCalledTimes(4);
      expect(fetchMessage).toHaveBeenCalledWith("/channels/channel-1/messages/1001");
      expect(resolveAgentRouteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          guildId: "guild-123",
          peer: { kind: "channel", id: "channel-1" },
        }),
      );
    } finally {
      enqueueSystemEventSpy.mockReset();
      fixtures.resetSystemEventsForTest();
      clearRuntimeConfigSnapshot();
    }
  });

  it("blocks DM reactions when dmPolicy is disabled", async () => {
    await handleReaction({ dmPolicy: "disabled" });

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("applies DM allowlist edits and revokes reactions awaiting channel metadata", async () => {
    const params = makeReactionListenerParams({ dmPolicy: "allowlist", allowFrom: [] });
    let cfg: OpenClawConfig = {
      channels: { discord: { dmPolicy: "allowlist", allowFrom: [] } },
    };
    const listener = new DiscordReactionListener({
      ...params,
      readPolicy: createDiscordLivePolicyReader({
        cfg,
        accountId: params.accountId,
        readConfig: () => cfg,
      }),
    });
    const data = makeReactionEvent({ botAsAuthor: true, userId: "user-1" });
    const client = makeReactionClient({ channelType: ChannelType.DM });
    await listener.handle(data, client);
    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    cfg = { channels: { discord: { dmPolicy: "allowlist", allowFrom: ["user:user-1"] } } };
    await listener.handle(data, client);
    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);

    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const fetchChannel = client.fetchChannel.bind(client);
    vi.spyOn(client, "fetchChannel").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return fetchChannel(...args);
    });
    const pending = listener.handle(data, client);
    await entered.promise;
    cfg = { channels: { discord: { dmPolicy: "allowlist", allowFrom: [] } } };
    release.resolve();
    await pending;
    await listener.handle(data, client);
    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks group DM reactions when group DMs are disabled", async () => {
    await handleReaction({ groupDmEnabled: false }, {}, ChannelType.GroupDM);

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks guild reactions when groupPolicy is disabled", async () => {
    const client = await handleReaction(
      { groupPolicy: "disabled" },
      { guildId: "guild-123", guild: { id: "guild-123", name: "Guild" } },
      ChannelType.GuildText,
    );

    expect(getReactionClientFetchChannelMock(client)).not.toHaveBeenCalled();
    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
  });

  it("blocks guild reactions for sender outside users allowlist", async () => {
    await handleReaction(
      { guildEntries: { "guild-123": { users: ["user:trusted-user"] } } },
      {
        guildId: "guild-123",
        userId: "attacker-user",
        guild: { id: "guild-123", name: "Test Guild" },
      },
      ChannelType.GuildText,
    );

    expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    expect(resolveAgentRouteMock).not.toHaveBeenCalled();
  });

  it("allows guild reactions for sender in channel role allowlist override", async () => {
    resolveAgentRouteMock.mockReturnValueOnce({
      agentId: "default",
      channel: "discord",
      accountId: "acc-1",
      sessionKey: "discord:acc-1:guild-123:channel-1",
      mainSessionKey: "discord:acc-1:guild-123:channel-1",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });

    const client = await handleReaction(
      {
        guildEntries: {
          "guild-123": {
            roles: ["role:blocked-role"],
            channels: { "channel-1": { enabled: true, roles: ["role:trusted-role"] } },
          },
        },
      },
      {
        guildId: "guild-123",
        userId: "member-user",
        guild: { id: "guild-123", name: "Test Guild" },
        memberRoleIds: ["trusted-role"],
      },
      ChannelType.GuildText,
    );

    expect(getReactionClientFetchChannelMock(client)).toHaveBeenCalled();
    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
    const text = firstMockArg(enqueueSystemEventSpy, "enqueueSystemEvent");
    expect(text).toContain("Discord reaction added");
  });

  it("routes group DM reactions with peer kind 'group'", async () => {
    await handleReaction({}, {}, ChannelType.GroupDM);

    expect(resolveAgentRouteMock).toHaveBeenCalledOnce();
    const routeArgs = firstMockArg(resolveAgentRouteMock, "resolveAgentRoute") as {
      peer?: unknown;
    };
    expect(routeArgs.peer).toEqual({ kind: "group", id: "channel-1" });
  });
});

describe("discord reaction notification modes", () => {
  const guildId = "guild-900";
  const guild = { id: guildId, name: "Mode Guild" };

  it("applies message-fetch behavior across notification modes and channel types", async () => {
    type Scenario = {
      users?: string[];
      userId?: string;
      channelType?: ChannelType;
      channelId?: string;
      parentId?: string;
      messageAuthorId?: string;
    };
    type Mode = NonNullable<Parameters<typeof shouldEmitDiscordReactionNotification>[0]["mode"]>;
    const cases: Array<[Mode, [number, number, number], Scenario?]> = [
      ["off", [0, 0, 0]],
      ["all", [1, 0, 1]],
      ["allowlist", [1, 0, 1], { users: ["123"], userId: "123" }],
      ["allowlist", [0, 0, 0], { users: ["trusted-user"], userId: "untrusted-user" }],
      ["own", [1, 1, 1], { messageAuthorId: "bot-1" }],
      [
        "all",
        [2, 0, 1],
        {
          channelType: ChannelType.PublicThread,
          channelId: "thread-1",
          parentId: "parent-1",
        },
      ],
    ];

    for (const [
      reactionNotifications,
      [channelCalls, messageCalls, enqueueCalls],
      testCase = {},
    ] of cases) {
      const name = `${reactionNotifications}: ${JSON.stringify(testCase)}`;
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      const messageFetch = vi.fn(async () => ({
        author: {
          id: testCase.messageAuthorId ?? "other-user",
          username: "author",
          discriminator: "0",
        },
      }));
      const data = makeReactionEvent({
        guildId,
        guild,
        userId: testCase.userId,
        channelId: testCase.channelId,
        messageFetch,
      });
      const client = makeReactionClient({
        channelType: testCase.channelType ?? ChannelType.GuildText,
        parentId: testCase.parentId,
      });
      const guildEntries = {
        [guildId]: {
          reactionNotifications,
          users: testCase.users ? [...testCase.users] : undefined,
        },
      };
      const listener = new DiscordReactionListener(makeReactionListenerParams({ guildEntries }));

      await listener.handle(data, client);

      expect(getReactionClientFetchChannelMock(client), name).toHaveBeenCalledTimes(channelCalls);
      expect(messageFetch, name).toHaveBeenCalledTimes(messageCalls);
      expect(enqueueSystemEventSpy, name).toHaveBeenCalledTimes(enqueueCalls);
    }
  });
});
