import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchMock,
  loadConfigMock,
  readAllowFromStoreMock,
  updateLastRouteMock,
  upsertPairingRequestMock,
} from "./monitor.tool-result.test-harness.js";
import { createDiscordMessageHandler } from "./monitor/message-handler.js";
import { __resetDiscordChannelInfoCacheForTest } from "./monitor/message-utils.js";
import { createNoopThreadBindingManager } from "./monitor/thread-bindings.js";

type Config = ReturnType<typeof import("../../../src/config/config.js").loadConfig>;

const BASE_CFG: Config = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      workspace: "/tmp/openclaw",
    },
  },
  messages: {
    inbound: { debounceMs: 0 },
  },
  session: { store: "/tmp/openclaw-sessions.json" },
};

beforeEach(() => {
  __resetDiscordChannelInfoCacheForTest();
  updateLastRouteMock.mockClear();
  dispatchMock.mockClear().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  loadConfigMock.mockClear().mockReturnValue(BASE_CFG);
});

function createHandlerBaseConfig(cfg: Config): Parameters<typeof createDiscordMessageHandler>[0] {
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "token",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    botUserId: "bot-id",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2000,
    replyToMode: "off",
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

async function createHandler(cfg: Config) {
  loadConfigMock.mockReturnValue(cfg);
  return createDiscordMessageHandler({
    ...createHandlerBaseConfig(cfg),
    guildEntries: cfg.channels?.discord?.guilds,
  });
}

function createGuildTextClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      id: "c1",
      type: ChannelType.GuildText,
      name: "general",
    }),
    rest: { get: vi.fn() },
  } as unknown as Client;
}

function createGuildMessageEvent(params: {
  messageId: string;
  content: string;
  messagePatch?: Record<string, unknown>;
  eventPatch?: Record<string, unknown>;
}) {
  const messageBase = {
    timestamp: new Date().toISOString(),
    type: MessageType.Default,
    attachments: [],
    embeds: [],
    mentionedEveryone: false,
    mentionedUsers: [],
    mentionedRoles: [],
  };
  return {
    message: {
      id: params.messageId,
      content: params.content,
      channelId: "c1",
      ...messageBase,
      author: { id: "u1", bot: false, username: "Ada" },
      ...params.messagePatch,
    },
    author: { id: "u1", bot: false, username: "Ada" },
    member: { nickname: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
    ...params.eventPatch,
  };
}

function createThreadChannel(params: { includeStarter?: boolean; type?: ChannelType } = {}) {
  return {
    id: "t1",
    type: params.type ?? ChannelType.PublicThread,
    name: "thread-name",
    parentId: params.type === ChannelType.PublicThread ? "forum-1" : "p1",
    parent: {
      id: params.type === ChannelType.PublicThread ? "forum-1" : "p1",
      name: params.type === ChannelType.PublicThread ? "support" : "general",
    },
    isThread: () => true,
    ...(params.includeStarter
      ? {
          fetchStarterMessage: async () => ({
            content: "starter message",
            author: { tag: "Alice#1", username: "Alice" },
            createdTimestamp: Date.now(),
          }),
        }
      : {}),
  };
}

function createThreadClient(
  params: {
    fetchChannel?: ReturnType<typeof vi.fn>;
    restGet?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    fetchChannel:
      params.fetchChannel ??
      vi
        .fn()
        .mockResolvedValueOnce({
          id: "t1",
          type: ChannelType.PublicThread,
          name: "thread-name",
          parentId: "p1",
          ownerId: "owner-1",
        })
        .mockResolvedValueOnce({
          id: "p1",
          type: ChannelType.GuildText,
          name: "general",
        }),
    rest: {
      get:
        params.restGet ??
        vi.fn().mockResolvedValue({
          content: "starter message",
          author: { id: "u1", username: "Alice", discriminator: "0001" },
          timestamp: new Date().toISOString(),
        }),
    },
  } as unknown as Client;
}

function createThreadEvent(messageId: string, channelId = "t1") {
  return {
    message: {
      id: messageId,
      content: "thread hello",
      channelId,
      timestamp: new Date().toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: { id: "u1", bot: false, username: "Ada" },
    },
    author: { id: "u1", bot: false, username: "Ada" },
    member: { nickname: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
  };
}

function createMentionRequiredGuildConfig(overrides?: Partial<Config>): Config {
  return {
    ...BASE_CFG,
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: {
          "*": {
            requireMention: true,
            channels: { c1: { allow: true } },
          },
        },
      },
    },
    ...overrides,
  } as Config;
}

function captureNextDispatchCtx<
  T extends {
    SessionKey?: string;
    ParentSessionKey?: string;
    ThreadStarterBody?: string;
    ThreadLabel?: string;
    WasMentioned?: boolean;
  },
>(): () => T | undefined {
  let capturedCtx: T | undefined;
  dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
    capturedCtx = ctx as T;
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { final: 1 } };
  });
  return () => capturedCtx;
}

describe("discord tool result dispatch", () => {
  it("accepts guild messages when mentionPatterns match", async () => {
    const cfg = createMentionRequiredGuildConfig({
      messages: {
        inbound: { debounceMs: 0 },
        groupChat: { mentionPatterns: ["\\bopenclaw\\b"] },
      },
    } as Partial<Config>);

    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(createGuildMessageEvent({ messageId: "m2", content: "openclaw: hello" }), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  });

  it("accepts guild reply-to-bot messages as implicit mentions", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ WasMentioned?: boolean }>();
    const cfg = createMentionRequiredGuildConfig();
    const handler = await createHandler(cfg);
    const client = createGuildTextClient();

    await handler(
      createGuildMessageEvent({
        messageId: "m3",
        content: "following up",
        messagePatch: {
          referencedMessage: {
            id: "m2",
            channelId: "c1",
            content: "bot reply",
            timestamp: new Date().toISOString(),
            type: MessageType.Default,
            attachments: [],
            embeds: [],
            mentionedEveryone: false,
            mentionedUsers: [],
            mentionedRoles: [],
            author: { id: "bot-id", bot: true, username: "OpenClaw" },
          },
        },
      }),
      client,
    );

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(getCapturedCtx()?.WasMentioned).toBe(true);
  });

  it("forks thread sessions and injects starter context", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = {
      ...createMentionRequiredGuildConfig(),
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          guilds: {
            "*": {
              requireMention: false,
              channels: { p1: { allow: true } },
            },
          },
        },
      },
    } as Config;

    const handler = await createHandler(cfg);
    const client = createThreadClient({
      fetchChannel: vi
        .fn()
        .mockResolvedValueOnce(createThreadChannel({ includeStarter: true }))
        .mockResolvedValueOnce({ id: "p1", type: ChannelType.GuildText, name: "general" }),
    });

    await handler(createThreadEvent("m4"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:p1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #general");
  });

  it("skips thread starter context when disabled", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{ ThreadStarterBody?: string }>();
    const cfg = {
      ...createMentionRequiredGuildConfig(),
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          guilds: {
            "*": {
              requireMention: false,
              channels: {
                p1: { allow: true, includeThreadStarter: false },
              },
            },
          },
        },
      },
    } as Config;

    const handler = await createHandler(cfg);
    const client = createThreadClient();

    await handler(createThreadEvent("m7"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    expect(getCapturedCtx()?.ThreadStarterBody).toBeUndefined();
  });

  it("treats forum threads as distinct sessions without channel payloads", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
      ThreadStarterBody?: string;
      ThreadLabel?: string;
    }>();
    const cfg = {
      ...createMentionRequiredGuildConfig(),
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          guilds: {
            "*": {
              requireMention: false,
              channels: { "forum-1": { allow: true } },
            },
          },
        },
      },
    } as Config;

    const fetchChannel = vi
      .fn()
      .mockResolvedValueOnce({
        id: "t1",
        type: ChannelType.PublicThread,
        name: "topic-1",
        parentId: "forum-1",
      })
      .mockResolvedValueOnce({
        id: "forum-1",
        type: ChannelType.GuildForum,
        name: "support",
      });
    const restGet = vi.fn().mockResolvedValue({
      content: "starter message",
      author: { id: "u1", username: "Alice", discriminator: "0001" },
      timestamp: new Date().toISOString(),
    });
    const handler = await createHandler(cfg);
    const client = createThreadClient({ fetchChannel, restGet });

    await handler(createThreadEvent("m6"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:forum-1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #support");
  });

  it("scopes thread sessions to the routed agent", async () => {
    const getCapturedCtx = captureNextDispatchCtx<{
      SessionKey?: string;
      ParentSessionKey?: string;
    }>();
    const cfg = {
      ...createMentionRequiredGuildConfig(),
      bindings: [{ agentId: "support", match: { channel: "discord", guildId: "g1" } }],
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          groupPolicy: "open",
          guilds: {
            "*": {
              requireMention: false,
              channels: { p1: { allow: true } },
            },
          },
        },
      },
    } as Config;

    const handler = await createHandler(cfg);
    const client = createThreadClient();

    await handler(createThreadEvent("m5"), client);

    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const capturedCtx = getCapturedCtx();
    expect(capturedCtx?.SessionKey).toBe("agent:support:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:support:discord:channel:p1");
  });
});
