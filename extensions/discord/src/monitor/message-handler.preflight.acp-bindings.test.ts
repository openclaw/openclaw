import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureConfiguredAcpBindingSessionMock = vi.hoisted(() => vi.fn());
const resolveConfiguredAcpBindingRecordMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/acp/persistent-bindings.js", () => ({
  ensureConfiguredAcpBindingSession: (...args: unknown[]) =>
    ensureConfiguredAcpBindingSessionMock(...args),
  resolveConfiguredAcpBindingRecord: (...args: unknown[]) =>
    resolveConfiguredAcpBindingRecordMock(...args),
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
    ensureConfiguredAcpBindingSessionMock.mockReset();
    resolveConfiguredAcpBindingRecordMock.mockReset();
    resolveConfiguredAcpBindingRecordMock.mockReturnValue(createConfiguredDiscordBinding());
    ensureConfiguredAcpBindingSessionMock.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:discord:default:abc123",
    });
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
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).not.toHaveBeenCalled();
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
    expect(resolveConfiguredAcpBindingRecordMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredAcpBindingSessionMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe("agent:codex:acp:binding:discord:default:abc123");
  });
});
