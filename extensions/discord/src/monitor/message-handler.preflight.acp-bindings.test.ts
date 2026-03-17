import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredAcpRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveConfiguredAcpRouteMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/channels/plugins/acp-routing.js", () => ({
  ensureConfiguredAcpRouteReady: (...args: unknown[]) => ensureConfiguredAcpRouteReadyMock(...args),
  resolveConfiguredAcpRoute: (...args: unknown[]) => resolveConfiguredAcpRouteMock(...args),
}));

import { __testing as sessionBindingTesting } from "../../../../src/infra/outbound/session-binding-service.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";

function createConfiguredDiscordBinding() {
  return {
    spec: {
      channel: "discord",
      accountId: "default",
      conversationId: CHANNEL_ID,
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:discord:default:channel-1",
      targetSessionKey: "agent:codex:acp:binding:discord:default:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: CHANNEL_ID,
      },
      status: "active",
      boundAt: 0,
      metadata: {
        source: "config",
        mode: "persistent",
        agentId: "codex",
      },
    },
  } as const;
}

function createConfiguredDiscordRoute() {
  const configuredBinding = createConfiguredDiscordBinding();
  return {
    configuredBinding,
    boundSessionKey: configuredBinding.record.targetSessionKey,
    route: {
      agentId: "codex",
      accountId: "default",
      channel: "discord",
      sessionKey: configuredBinding.record.targetSessionKey,
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      lastRoutePolicy: "bound",
    },
  } as const;
}

function createBasePreflightParams(overrides?: Record<string, unknown>) {
  const message = createDiscordMessage({
    id: "m-1",
    channelId: CHANNEL_ID,
    content: "<@bot-1> hello",
    mentionedUsers: [{ id: "bot-1" }],
    author: {
      id: "user-1",
      bot: false,
      username: "alice",
    },
  });

  return {
    ...createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: {
        allowBots: true,
      } as NonNullable<
        import("../../../../src/config/config.js").OpenClawConfig["channels"]
      >["discord"],
      data: createGuildEvent({
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: message.author,
        message,
      }),
      client: createGuildTextClient(CHANNEL_ID),
      botUserId: "bot-1",
    }),
    discordConfig: {
      allowBots: true,
    } as NonNullable<
      import("../../../../src/config/config.js").OpenClawConfig["channels"]
    >["discord"],
    ...overrides,
  } satisfies Parameters<typeof preflightDiscordMessage>[0];
}

describe("preflightDiscordMessage configured ACP bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    ensureConfiguredAcpRouteReadyMock.mockReset();
    resolveConfiguredAcpRouteMock.mockReset();
    resolveConfiguredAcpRouteMock.mockReturnValue(createConfiguredDiscordRoute());
    ensureConfiguredAcpRouteReadyMock.mockResolvedValue({ ok: true });
  });

  it("does not initialize configured ACP bindings for rejected messages", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: false,
              },
            },
          },
        },
      }),
    );

    expect(result).toBeNull();
    expect(resolveConfiguredAcpRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpRouteReadyMock).not.toHaveBeenCalled();
  });

  it("initializes configured ACP bindings only after preflight accepts the message", async () => {
    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(resolveConfiguredAcpRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });

  it("accepts plain messages in configured ACP-bound channels without a mention", async () => {
    const message = createDiscordMessage({
      id: "m-no-mention",
      channelId: CHANNEL_ID,
      content: "hello",
      mentionedUsers: [],
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: true,
                requireMention: true,
              },
            },
          },
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(ensureConfiguredAcpRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });

  it("hydrates empty guild message payloads from REST before ensuring configured ACP bindings", async () => {
    const message = createDiscordMessage({
      id: "m-rest",
      channelId: CHANNEL_ID,
      content: "",
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });
    const restGet = vi.fn(async () => ({
      id: "m-rest",
      content: "hello from rest",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      author: {
        id: "user-1",
        username: "alice",
      },
    }));
    const client = {
      ...createGuildTextClient(CHANNEL_ID),
      rest: {
        get: restGet,
      },
    } as Parameters<typeof preflightDiscordMessage>[0]["client"];

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        client,
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      }),
    );

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("hello from rest");
    expect(result?.data.message.content).toBe("hello from rest");
    expect(ensureConfiguredAcpRouteReadyMock).toHaveBeenCalledTimes(1);
  });

  it("hydrates sticker-only guild message payloads from REST before ensuring configured ACP bindings", async () => {
    const message = createDiscordMessage({
      id: "m-rest-sticker",
      channelId: CHANNEL_ID,
      content: "",
      author: {
        id: "user-1",
        bot: false,
        username: "alice",
      },
    });
    const restGet = vi.fn(async () => ({
      id: "m-rest-sticker",
      content: "",
      attachments: [],
      embeds: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      sticker_items: [
        {
          id: "sticker-1",
          name: "wave",
        },
      ],
      author: {
        id: "user-1",
        username: "alice",
      },
    }));
    const client = {
      ...createGuildTextClient(CHANNEL_ID),
      rest: {
        get: restGet,
      },
    } as Parameters<typeof preflightDiscordMessage>[0]["client"];

    const result = await preflightDiscordMessage(
      createBasePreflightParams({
        client,
        data: createGuildEvent({
          channelId: CHANNEL_ID,
          guildId: GUILD_ID,
          author: message.author,
          message,
        }),
        guildEntries: {
          [GUILD_ID]: {
            id: GUILD_ID,
            channels: {
              [CHANNEL_ID]: {
                allow: true,
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      }),
    );

    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("<media:sticker> (1 sticker)");
    expect(ensureConfiguredAcpRouteReadyMock).toHaveBeenCalledTimes(1);
  });
});
