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
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordOwnerAccess,
  shouldEmitDiscordReactionNotification,
} from "./monitor/allow-list.js";
import { createDiscordLivePolicyReader } from "./monitor/live-policy.js";
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

beforeEach(() => {
  setDiscordRuntime(createPluginRuntimeMock());
  vi.useRealTimers();
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
});

it("dedupes listeners by constructor", () => {
  class FakeListener {
    readonly type = "fake";
  }
  const listeners: object[] = [];
  expect(registerDiscordListener(listeners, new FakeListener())).toBe(true);
  expect(registerDiscordListener(listeners, new FakeListener())).toBe(false);
  expect(listeners).toHaveLength(1);
});

describe("DiscordMessageListener", () => {
  const messageEvent = {} as Parameters<InstanceType<typeof DiscordMessageListener>["handle"]>[0];
  const messageClient = {} as import("./internal/discord.js").Client;
  async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("awaits each durable handoff without blocking subsequent events", async () => {
    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const handler = vi
      .fn<ConstructorParameters<typeof DiscordMessageListener>[0]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const listener = new DiscordMessageListener(handler);
    const settled: string[] = [];
    const firstHandle = listener
      .handle(messageEvent, messageClient)
      .then(() => settled.push("first"));
    const secondHandle = listener
      .handle(messageEvent, messageClient)
      .then(() => settled.push("second"));
    await flushAsyncWork();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(settled).toEqual([]);
    first.resolve();
    await firstHandle;
    expect(settled).toEqual(["first"]);
    second.resolve();
    await secondHandle;
    expect(settled).toEqual(["first", "second"]);
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
    expect(logger.error).toHaveBeenCalledWith(danger("discord handler failed: Error: boom"));
  });
});

describe("discord allowlist helpers", () => {
  it("does not treat DM wildcard access as owner access", () => {
    const access = (allowFrom: string[]) =>
      resolveDiscordOwnerAccess({ allowFrom, sender: { id: "123" } });
    expect(access(["*"])).toEqual({ ownerAllowList: null, ownerAllowed: false });
    const explicitOwner = access(["*", "user:123"]);
    expect(explicitOwner).toMatchObject({
      ownerAllowList: { allowAll: false },
      ownerAllowed: true,
    });
    expect(explicitOwner.ownerAllowList?.ids).toEqual(new Set(["123"]));
  });
});

it.each([
  ["unmatched channel", { general: { enabled: true } }, "channel", { allowed: false }],
  [
    "thread name cannot bypass parent denial",
    { general: { enabled: true }, random: { enabled: false } },
    "thread",
    { allowed: false },
  ],
  [
    "wildcard fallback",
    { "*": { enabled: true, requireMention: false } },
    "thread",
    { allowed: true, matchKey: "*", matchSource: "wildcard" },
  ],
] as const)("resolves channel policy: %s", (_, channels, scope, expected) => {
  expect(
    resolveDiscordChannelConfigWithFallback({
      guildInfo: { channels },
      scope,
      channelId: "999",
      channelName: scope === "thread" ? "general" : "random",
      channelSlug: scope === "thread" ? "general" : "random",
      ...(scope === "thread"
        ? { parentId: "parent", parentName: "random", parentSlug: "random" }
        : {}),
    }),
  ).toMatchObject(expected);
});

// The listener's earlier ingress gate masks these direct notification-policy denials.
it.each(["off", "all", "own"] as const)("denies restricted notification mode %s", (mode) => {
  expect(
    shouldEmitDiscordReactionNotification({
      botId: "bot-1",
      messageAuthorId: "bot-1",
      userId: "user-2",
      mode,
      guildInfo: { users: ["trusted-user"] },
    }),
  ).toBe(false);
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
const user = (id: string, username: string) => ({ id, username, discriminator: "0", bot: false });

function makeReactionEvent(
  overrides: {
    guildId?: string;
    channelId?: string;
    userId?: string;
    username?: string;
    messageAuthorId?: string;
    memberRoleIds?: string[];
  } = {},
) {
  return {
    guild_id: overrides.guildId,
    channel_id: overrides.channelId ?? "channel-1",
    message_id: "1001",
    emoji: { name: "👍", id: null },
    guild: overrides.guildId ? { id: overrides.guildId, name: "Test Guild" } : undefined,
    rawMember: overrides.memberRoleIds ? { roles: overrides.memberRoleIds } : undefined,
    user: user(overrides.userId ?? "user-1", overrides.username ?? "testuser"),
    message: {
      fetch: vi.fn(async () => ({ author: user(overrides.messageAuthorId ?? "bot-1", "bot") })),
    },
  } as unknown as DiscordReactionEvent;
}

function makeReactionClient(
  channelType = ChannelType.DM,
  parentId?: string,
  name = channelType === ChannelType.DM ? undefined : "test-channel",
) {
  return {
    fetchChannel: vi.fn(async (channelId: string) => {
      if (parentId && channelId === parentId) {
        return { type: ChannelType.GuildText, name: "parent-channel", parentId: undefined };
      }
      return { type: channelType, name, parentId };
    }),
  } as unknown as DiscordReactionClient;
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
  const data = makeReactionEvent(event);
  const client = makeReactionClient(channelType);
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

  it.each([undefined, { "guild-123": { slug: "guild-123" } }])(
    "processes DM reactions independently of guild allowlists: %j",
    async (guildEntries) => {
      await handleReaction({ guildEntries });
      expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
      const [text, opts] = firstMockCall(enqueueSystemEventSpy, "enqueueSystemEvent");
      expect(text).toContain("Discord reaction added: 👍 by testuser on dm");
      expect(text).not.toContain("undefined");
      expect(requireRecord(opts, "system event options").sessionKey).toBe(
        "discord:acc-1:dm:user-1",
      );
    },
  );

  it("keeps the actor id when a reaction removal does not include a Discord username", async () => {
    const data = makeReactionEvent({ userId: "user-42", username: "" });
    const client = makeReactionClient();
    const listener = new DiscordReactionRemoveListener(makeReactionListenerParams());

    await listener.handle(data, client);

    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
    const text = firstMockArg(enqueueSystemEventSpy, "enqueueSystemEvent");
    expect(text).toContain("Discord reaction removed: 👍 by user-42 on");
  });

  it.each([
    ["added", GatewayDispatchEvents.MessageReactionAdd, DiscordReactionListener],
    ["removed", GatewayDispatchEvents.MessageReactionRemove, DiscordReactionRemoveListener],
  ] as const)(
    "preserves normal/super reaction identity when %s",
    async (action, event, Listener) => {
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
          author: user("bot-1", "bot"),
        }));
        const client = Object.assign(
          makeReactionClient(ChannelType.GuildText, undefined, "general"),
          { rest: { get: fetchMessage } },
        );
        const listener = new Listener(params);
        const gatewayEvent = {
          user_id: "user-1",
          channel_id: "channel-1",
          message_id: "1001",
          guild_id: "guild-123",
          emoji: { id: null, name: "👍" },
          ...(action === "added" ? { member: { user: user("user-1", "actor"), roles: [] } } : {}),
        };

        for (const burst of [false, true, false, true]) {
          await listener.handle(
            mapGatewayDispatchData(client, event, {
              ...gatewayEvent,
              burst,
              type: Number(burst),
            }) as DiscordReactionEvent,
            client,
          );
        }

        const events = channelRuntimeModule.peekSystemEventEntries("discord:acc-1:dm:user-1");
        const actor = action === "added" ? "actor" : "user-1";
        expect(events.map(({ text, contextKey }) => [text, contextKey])).toEqual([
          [
            `Discord reaction ${action}: 👍 by ${actor} on guild-123 #general msg 1001 from bot`,
            `discord:reaction:${action}:1001:user-1:👍`,
          ],
          [
            `Discord super reaction ${action}: 👍 by ${actor} on guild-123 #general msg 1001 from bot`,
            `discord:reaction:${action}:1001:user-1:👍:burst`,
          ],
        ]);
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
    },
  );

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
    const data = makeReactionEvent();
    const client = makeReactionClient();
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

  it.each([
    ["DM policy", { dmPolicy: "disabled" }, ChannelType.DM],
    ["group DM policy", { groupDmEnabled: false }, ChannelType.GroupDM],
    ["guild policy", { groupPolicy: "disabled" }, ChannelType.GuildText],
    ["unlisted guild", { groupPolicy: "allowlist" }, ChannelType.GuildText],
    [
      "denied channel",
      {
        groupPolicy: "allowlist",
        guildEntries: {
          "guild-123": { channels: { "channel-1": { enabled: false } } },
        },
      },
      ChannelType.GuildText,
    ],
    [
      "guild user allowlist",
      { guildEntries: { "guild-123": { users: ["user:trusted-user"] } } },
      ChannelType.GuildText,
    ],
  ] satisfies Array<[string, Parameters<typeof makeReactionListenerParams>[0], ChannelType]>)(
    "blocks reactions denied by %s",
    async (_, params, type) => {
      await handleReaction(
        params,
        type === ChannelType.GuildText
          ? {
              guildId: "guild-123",
              userId: "attacker-user",
            }
          : {},
        type,
      );
      expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
    },
  );

  it("allows guild reactions for sender in channel role allowlist override", async () => {
    await handleReaction(
      {
        groupPolicy: "allowlist",
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
        memberRoleIds: ["trusted-role"],
      },
      ChannelType.GuildText,
    );

    expect(enqueueSystemEventSpy).toHaveBeenCalledOnce();
    const text = firstMockArg(enqueueSystemEventSpy, "enqueueSystemEvent");
    expect(text).toContain("Discord reaction added");
  });

  it.each([undefined, "test-channel", "other"])(
    "routes only allowed group DMs: %s",
    async (channel) => {
      await handleReaction({ groupDmChannels: channel ? [channel] : [] }, {}, ChannelType.GroupDM);
      if (channel === "other") {
        expect(enqueueSystemEventSpy).not.toHaveBeenCalled();
        expect(resolveAgentRouteMock).not.toHaveBeenCalled();
      } else {
        expect(resolveAgentRouteMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            peer: { kind: "group", id: "channel-1" },
          }),
        );
      }
    },
  );
});

describe("discord reaction notification modes", () => {
  const guildId = "guild-900";

  it("admits reactions by notification mode, sender and channel type", async () => {
    type Scenario = Parameters<typeof makeReactionEvent>[0] & {
      channelType?: ChannelType;
      parentId?: string;
      users?: string[];
      allowNameMatching?: boolean;
    };
    type Mode = Parameters<typeof shouldEmitDiscordReactionNotification>[0]["mode"];
    const cases: Array<[Mode, number, Scenario?]> = [
      ["off", 0],
      ["all", 1],
      ["allowlist", 1, { users: ["123"], userId: "123" }],
      ["allowlist", 0, { users: ["trusted-user"], userId: "untrusted-user" }],
      ["allowlist", 0, { users: [] }],
      ["allowlist", 0, { users: ["Trusted User"], username: "trusted-user" }],
      [
        "allowlist",
        1,
        { users: ["Trusted User"], username: "trusted-user", allowNameMatching: true },
      ],
      ["own", 1, { messageAuthorId: "bot-1" }],
      [undefined, 0],
      [
        "all",
        1,
        {
          channelType: ChannelType.PublicThread,
          channelId: "thread-1",
          parentId: "parent-1",
        },
      ],
    ];

    for (const [reactionNotifications, enqueueCalls, testCase = {}] of cases) {
      const name = `${reactionNotifications}: ${JSON.stringify(testCase)}`;
      enqueueSystemEventSpy.mockClear();
      resolveAgentRouteMock.mockClear();

      const data = makeReactionEvent({
        ...testCase,
        guildId,
        messageAuthorId: testCase.messageAuthorId ?? "other-user",
      });
      const client = makeReactionClient(
        testCase.channelType ?? ChannelType.GuildText,
        testCase.parentId,
      );
      const listener = new DiscordReactionListener(
        makeReactionListenerParams({
          groupPolicy: "allowlist",
          allowNameMatching: testCase.allowNameMatching ?? false,
          guildEntries: { [guildId]: { reactionNotifications, users: testCase.users } },
        }),
      );

      await listener.handle(data, client);

      expect(enqueueSystemEventSpy, name).toHaveBeenCalledTimes(enqueueCalls);
    }
  });
});
