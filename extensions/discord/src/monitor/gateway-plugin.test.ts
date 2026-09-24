// Discord tests cover gateway plugin plugin behavior.
import { EventEmitter } from "node:events";
import { GatewayIntentBits as GatewayIntents } from "discord-api-types/v10";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT } from "./gateway-handle.js";
import {
  fetchDiscordGatewayInfoWithTimeout,
  resolveDiscordGatewayInfoTimeoutMs,
} from "./gateway-metadata.js";

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  captureHttpExchange: vi.fn(),
  captureWsEvent: vi.fn(),
  resolveEffectiveDebugProxyUrl: () => undefined,
  resolveDebugProxySettings: () => ({ enabled: false }),
}));

// Suite runs isolate=false: a partial factory here poisons the shared module
// cache for later files in the worker (#123025), so spread the real module.
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    danger: (value: string) => value,
    warn: (value: string) => value,
  };
});

describe("createDiscordGatewayPlugin", () => {
  let createDiscordGatewayPlugin: typeof import("./gateway-plugin.js").createDiscordGatewayPlugin;
  let resolveDiscordGatewayIntents: typeof import("./gateway-plugin.js").resolveDiscordGatewayIntents;

  beforeAll(async () => {
    ({ createDiscordGatewayPlugin, resolveDiscordGatewayIntents } =
      await import("./gateway-plugin.js"));
  });

  function createPlugin(
    testing?: NonNullable<Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]>,
    discordConfig: Parameters<typeof createDiscordGatewayPlugin>[0]["discordConfig"] = {},
    runtime: Parameters<typeof createDiscordGatewayPlugin>[0]["runtime"] = createRuntimeSpies(),
  ) {
    return createDiscordGatewayPlugin({
      discordConfig,
      runtime,
      ...(testing ? { testing } : {}),
    });
  }

  it("keeps the public intent helper's no-argument defaults", () => {
    const intents = resolveDiscordGatewayIntents();
    expect(intents & GatewayIntents.GuildExpressions).toBe(GatewayIntents.GuildExpressions);
    expect(intents & GatewayIntents.GuildVoiceStates).toBe(0);
    expect(intents & GatewayIntents.MessageContent).toBe(GatewayIntents.MessageContent);
  });

  it.each<{
    name: string;
    config: Parameters<typeof createDiscordGatewayPlugin>[0]["discordConfig"];
    voice?: boolean;
    messageContent?: boolean;
    privileged?: boolean;
  }>([
    { name: "absent voice config", config: {} },
    { name: "disabled voice", config: { voice: { enabled: false } } },
    { name: "enabled voice", config: { voice: { enabled: true } }, voice: true },
    { name: "existing voice block", config: { voice: {} }, voice: true },
    {
      name: "mention-only content",
      config: { intents: { messageContent: false } },
      messageContent: false,
    },
    {
      name: "voice intent overriding disabled voice",
      config: { voice: { enabled: false }, intents: { voiceStates: true } },
      voice: true,
    },
    {
      name: "voice intent overriding enabled voice",
      config: { voice: { enabled: true }, intents: { voiceStates: false } },
    },
    {
      name: "privileged intents",
      config: { intents: { presence: true, guildMembers: true } },
      privileged: true,
    },
  ])(
    "configures the real gateway for $name",
    ({ config, voice = false, messageContent = true, privileged = false }) => {
      const plugin = createPlugin(undefined, config);
      expect(plugin.options).toEqual({
        autoInteractions: false,
        intents:
          GatewayIntents.Guilds |
          GatewayIntents.GuildExpressions |
          GatewayIntents.GuildMessages |
          GatewayIntents.DirectMessages |
          GatewayIntents.GuildMessageReactions |
          GatewayIntents.DirectMessageReactions |
          (messageContent ? GatewayIntents.MessageContent : 0) |
          (voice ? GatewayIntents.GuildVoiceStates : 0) |
          (privileged ? GatewayIntents.GuildPresences | GatewayIntents.GuildMembers : 0),
        reconnect: { maxAttempts: 50 },
      });
    },
  );

  it("resolves gateway metadata timeout from env, then default", () => {
    expect(
      resolveDiscordGatewayInfoTimeoutMs({
        env: { OPENCLAW_DISCORD_GATEWAY_INFO_TIMEOUT_MS: "25000" },
      }),
    ).toBe(25_000);
    expect(resolveDiscordGatewayInfoTimeoutMs({ env: {} })).toBe(30_000);
  });

  it("parses valid Discord gateway metadata", async () => {
    await expect(
      fetchDiscordGatewayInfoWithTimeout({
        token: "test",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              url: "wss://gateway.discord.gg",
              shards: 1,
              session_start_limit: {
                total: 1000,
                remaining: 999,
                reset_after: 0,
                max_concurrency: 1,
              },
            }),
          ),
      }),
    ).resolves.toEqual({
      url: "wss://gateway.discord.gg",
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 0,
        max_concurrency: 1,
      },
    });
  });

  it("rejects malformed Discord gateway metadata", async () => {
    await expect(
      fetchDiscordGatewayInfoWithTimeout({
        token: "test",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              url: "wss://gateway.discord.gg",
              shards: 0,
              session_start_limit: {
                total: 1000,
                remaining: 999,
                reset_after: 0,
                max_concurrency: 1,
              },
            }),
          ),
      }),
    ).rejects.toThrow(/url|shards/);
  });

  function createSocketPlugin() {
    const socket = new EventEmitter() as EventEmitter & { binaryType?: string };
    const runtime = createRuntimeSpies();
    const plugin = createPlugin(
      {
        webSocketCtor: function WebSocketCtor() {
          return socket;
        } as unknown as NonNullable<
          Parameters<typeof createDiscordGatewayPlugin>[0]["testing"]
        >["webSocketCtor"],
      },
      {},
      runtime,
    );
    const createdSocket = (
      plugin as unknown as { createWebSocket: (url: string) => typeof socket }
    ).createWebSocket("wss://gateway.discord.gg");
    return { plugin, socket, createdSocket, runtime };
  }

  it("emits transport activity for current gateway socket messages", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { plugin, createdSocket } = createSocketPlugin();
    const activitySpy = vi.fn();
    plugin.emitter.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, activitySpy);
    (plugin as unknown as { ws: unknown }).ws = createdSocket;
    try {
      createdSocket.emit("message", Buffer.from("{}"));
      expect(activitySpy).toHaveBeenCalledWith({ at: 1_700_000_000_000 });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("ignores messages from stale gateway sockets", () => {
    const { plugin, socket, createdSocket } = createSocketPlugin();
    const activitySpy = vi.fn();
    plugin.emitter.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, activitySpy);
    expect(createdSocket).toBe(socket);
    (plugin as unknown as { ws: unknown }).ws = new EventEmitter();
    socket.emit("message", Buffer.from("{}"));
    expect(activitySpy).not.toHaveBeenCalled();
  });

  it("logs Discord gateway websocket error and abnormal close details", () => {
    const { createdSocket, runtime } = createSocketPlugin();
    const receiverLimitError = Object.assign(new Error("Too many buffered parts"), {
      code: "WS_ERR_TOO_MANY_BUFFERED_PARTS",
    });

    createdSocket.emit("error", receiverLimitError);
    createdSocket.emit("close", 1008, Buffer.from("policy violation"));

    const logs = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("discord: gateway websocket error");
    expect(logs).toContain("code=WS_ERR_TOO_MANY_BUFFERED_PARTS");
    expect(logs).toContain("discord: gateway websocket closed");
    expect(logs).toContain("code=1008");
    expect(logs).toContain("reason=policy violation");
    expect(logs).toContain("lastErrorCode=WS_ERR_TOO_MANY_BUFFERED_PARTS");
    expect(logs).toContain("hint=possible ws receiver buffered-parts limit");
  });

  it("keeps gateway close reason logs UTF-16 safe", () => {
    const { createdSocket, runtime } = createSocketPlugin();
    createdSocket.emit("close", 1008, Buffer.from(`${"A".repeat(239)}🧪 tail`));

    const log = String(runtime.log.mock.calls.at(-1)?.[0]);
    expect(log).toContain("discord: gateway websocket closed");
    expect(log).toContain("code=1008");
    expect(log).toContain(`reason=${"A".repeat(239)}...`);
    expect(log).toContain("hint=possible ws receiver buffered-parts limit");
  });
});
