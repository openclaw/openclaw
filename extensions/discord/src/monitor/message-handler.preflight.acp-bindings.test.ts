import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";

installDiscordIngressTestRuntime();
import * as conversationBindingRuntime from "openclaw/plugin-sdk/conversation-binding-runtime";
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createThreadBinding,
  runThreadBoundPreflight,
  createDiscordPreflightArgs,
  createGuildEvent,
  createGuildTextClient,
  DEFAULT_PREFLIGHT_CFG,
} from "./message-handler.preflight.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const { createConfiguredBindingConversationRuntimeModuleMock } =
    await import("../test-support/configured-binding-runtime.js");
  return await createConfiguredBindingConversationRuntimeModuleMock(
    { ensureConfiguredBindingRouteReadyMock, resolveConfiguredBindingRouteMock },
    () =>
      vi.importActual<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>(
        "openclaw/plugin-sdk/conversation-binding-runtime",
      ),
  );
});

const GUILD_ID = "guild-1";
const CHANNEL_ID = "channel-1";
const SESSION_KEY = "agent:codex:acp:binding:discord:default:abc123";
const AUTHOR = { id: "user-1", bot: false, username: "alice" };

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
  const statefulTarget = {
    kind: "stateful",
    driverId: "acp",
    sessionKey: SESSION_KEY,
    agentId: "codex",
  } as const;
  return {
    bindingResolution: {
      conversation,
      compiledBinding: {
        channel: "discord",
        accountPattern: "default",
        binding: {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: CHANNEL_ID },
          },
        },
        bindingConversationId: CHANNEL_ID,
        target: { conversationId: CHANNEL_ID },
        agentId: "codex",
        provider: {
          compileConfiguredBinding: () => ({ conversationId: CHANNEL_ID }),
          matchInboundConversation: () => ({ conversationId: CHANNEL_ID }),
        },
        targetFactory: { driverId: "acp", materialize: () => ({ record, statefulTarget }) },
      },
      match: { conversationId: CHANNEL_ID },
      record,
      statefulTarget,
    },
    configuredBinding: { spec: { ...conversation, agentId: "codex", mode: "persistent" }, record },
    boundSessionKey: SESSION_KEY,
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

describe("preflightDiscordMessage ACP bindings", () => {
  beforeEach(() => {
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReturnValue(createConfiguredDiscordRoute());
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    vi.spyOn(conversationBindingRuntime, "resolveConfiguredBindingRoute").mockImplementation(
      resolveConfiguredBindingRouteMock,
    );
    vi.spyOn(conversationBindingRuntime, "ensureConfiguredBindingRouteReady").mockImplementation(
      ensureConfiguredBindingRouteReadyMock,
    );
  });

  it("does not initialize configured ACP bindings for rejected messages", async () => {
    const message = createDiscordMessage({
      id: "m-1",
      channelId: CHANNEL_ID,
      content: "<@bot-1> hello",
      mentionedUsers: [{ id: "bot-1" }],
      author: AUTHOR,
    });
    expect(await preflightDiscordMessage(preflightParams(message, false))).toBeNull();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
  });

  it("hydrates sticker-only guild messages before admitting the configured ACP route", async () => {
    const message = createDiscordMessage({
      id: "1002",
      channelId: CHANNEL_ID,
      content: "",
      author: AUTHOR,
    });
    const restGet = vi.fn(async () => ({
      ...message.rawData,
      sticker_items: [{ id: "sticker-1", name: "wave" }],
    }));
    const client = Object.assign(createGuildTextClient(CHANNEL_ID), {
      rest: { get: restGet },
    }) as unknown as Parameters<typeof preflightDiscordMessage>[0]["client"];
    const result = await preflightDiscordMessage(preflightParams(message, true, client));
    expect(restGet).toHaveBeenCalledTimes(1);
    expect(result?.messageText).toBe("");
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(result?.boundSessionKey).toBe(SESSION_KEY);
    expect(result?.boundAgentId).toBe("codex");
    expect(result?.route.sessionKey).toBe(SESSION_KEY);
    expect(result?.route.agentId).toBe("codex");
  });
  it("keeps the Discord source route when a runtime ACP binding targets another owner", async () => {
    const defaultThreadBindings = createNoopThreadBindingManager("default");
    onTestFinished(async () => {
      await defaultThreadBindings.stop();
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
    });
    const threadId = "thread-runtime-acp-owner";
    const parentId = "channel-runtime-acp-owner";
    const targetSessionKey = "agent:claude:acp:runtime:discord-thread";
    const threadBinding = createThreadBinding({
      targetKind: "session",
      targetSessionKey,
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: threadId,
        parentConversationId: parentId,
      },
      metadata: {
        agentId: "worker",
        boundBy: "user-1",
      },
    });

    const result = await runThreadBoundPreflight({
      threadBindings: defaultThreadBindings,
      threadId,
      parentId,
      message: createDiscordMessage({
        id: "m-runtime-acp-owner",
        channelId: threadId,
        content: "continue in ACP",
        author: { id: "user-1", bot: false, username: "alice" },
      }),
      threadBinding,
      discordConfig: {},
      registerBindingAdapter: true,
    });

    if (!result) {
      throw new Error("Expected Discord preflight result");
    }
    const preflight = result;
    expect(preflight.boundSessionKey).toBe(targetSessionKey);
    expect(preflight.boundAgentId).toBe("claude");
    expect(preflight.route).toMatchObject({
      agentId: "main",
      sessionKey: `agent:main:discord:channel:${threadId}`,
    });
  });
});
