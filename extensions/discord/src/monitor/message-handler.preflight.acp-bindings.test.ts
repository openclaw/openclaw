import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>();
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: ensureConfiguredBindingRouteReadyMock,
    resolveConfiguredBindingRoute: resolveConfiguredBindingRouteMock,
  };
});

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";
const SESSION_KEY = "agent:codex:acp:binding:discord:default:abc123";
function createMessage(content = "", mentionedUsers: Array<{ id: string }> = []) {
  return createDiscordMessage({
    id: "1002",
    channelId: CHANNEL_ID,
    content,
    mentionedUsers,
    author: { id: "user-1", bot: false, username: "alice" },
  });
}

function createConfiguredDiscordRoute() {
  const conversation = { channel: "discord", accountId: "default", conversationId: CHANNEL_ID };
  const record = {
    bindingId: "config:acp:discord:default:channel-1",
    targetSessionKey: SESSION_KEY,
    targetKind: "session",
    conversation,
    status: "active",
    boundAt: 0,
    metadata: { source: "config", mode: "persistent", agentId: "codex" },
  } as const;
  return {
    // Preflight consumes the record and route; binding compilation/readiness is mocked.
    bindingResolution: { record },
    route: {
      agentId: "codex",
      accountId: "default",
      channel: "discord",
      sessionKey: SESSION_KEY,
      mainSessionKey: "agent:codex:main",
      matchedBy: "binding.channel",
      lastRoutePolicy: "bound",
    },
  } as const;
}

function preflightParams(
  message: ReturnType<typeof createDiscordMessage>,
  enabled: boolean,
  client = createGuildTextClient(CHANNEL_ID),
) {
  return {
    ...createDiscordPreflightArgs({
      cfg: DEFAULT_PREFLIGHT_CFG,
      discordConfig: { allowBots: true },
      data: createGuildEvent({
        channelId: CHANNEL_ID,
        guildId: GUILD_ID,
        author: message.author,
        message,
      }),
      client,
      botUserId: "bot-1",
    }),
    guildEntries: {
      [GUILD_ID]: { id: GUILD_ID, channels: { [CHANNEL_ID]: { enabled, requireMention: false } } },
    },
  };
}

describe("preflightDiscordMessage configured ACP bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReturnValue(createConfiguredDiscordRoute());
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
  });

  it("does not initialize configured ACP bindings for rejected messages", async () => {
    const input = createMessage("<@bot-1> hello", [{ id: "bot-1" }]);
    expect(await preflightDiscordMessage(preflightParams(input, false))).toBeNull();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("hydrates sticker-only guild messages before admitting the configured ACP route", async () => {
    const input = createMessage();
    const restGet = vi.fn(async () => ({
      ...input.rawData,
      sticker_items: [{ id: "sticker-1", name: "wave" }],
    }));
    const client = Object.assign(createGuildTextClient(CHANNEL_ID), {
      rest: { get: restGet },
    }) as unknown as Parameters<typeof preflightDiscordMessage>[0]["client"];
    const result = await preflightDiscordMessage(preflightParams(input, true, client));
    expect(restGet).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      messageText: "",
      boundSessionKey: SESSION_KEY,
      route: { sessionKey: SESSION_KEY, agentId: "codex" },
    });
  });
});
