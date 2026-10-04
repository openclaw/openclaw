import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "../internal/client.js";

const { registerVoiceClientSpy, waitForRegistration, stopPresenceListener } = vi.hoisted(() => ({
  registerVoiceClientSpy: vi.fn(),
  stopPresenceListener: vi.fn(async () => {}),
  waitForRegistration: vi.fn(),
}));
vi.mock("../internal/voice.js", () => ({
  VoicePlugin: class VoicePlugin {
    id = "voice";
    registerClient(client: Pick<Client, "getPlugin">) {
      registerVoiceClientSpy(client);
      if (!client.getPlugin("gateway")) {
        throw new Error("gateway plugin missing");
      }
    }
  },
}));
vi.mock("openclaw/plugin-sdk/dangerous-name-runtime", () => ({
  isDangerousNameMatchingEnabled: () => false,
}));
// isolate=false shares this cache with later files; retain the real runtime exports (#123025).
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (value: string) => value,
}));
vi.mock("../proxy-request-client.js", () => ({
  DISCORD_REST_TIMEOUT_MS: 15_000,
  createDiscordRequestClient: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  })),
}));
vi.mock("./auto-presence.js", () => ({ createDiscordAutoPresenceController: vi.fn() }));
vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: vi.fn(),
  waitForDiscordGatewayPluginRegistration: waitForRegistration,
}));
vi.mock("./gateway-supervisor.js", () => ({ createDiscordGatewaySupervisor: vi.fn() }));
vi.mock("./listeners.js", () => {
  const listener = (type: string) =>
    function () {
      return { type };
    };
  return {
    DiscordMessageListener: listener("message"),
    DiscordInteractionListener: listener("interaction"),
    DiscordPresenceListener: function DiscordPresenceListener() {
      return { type: "presence", stop: stopPresenceListener };
    },
    DiscordPresenceGuildCreateListener: listener("presence-guild-create"),
    DiscordPresenceGuildDeleteListener: listener("presence-guild-delete"),
    DiscordPresenceReadyListener: listener("presence-ready"),
    DiscordReactionListener: listener("reaction-add"),
    DiscordReactionRemoveListener: listener("reaction-remove"),
    DiscordThreadDeleteListener: listener("thread-delete"),
    DiscordThreadReadyListener: listener("thread-ready"),
    DiscordThreadUpdateListener: listener("thread-update"),
    registerDiscordListener: vi.fn(),
  };
});

import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { DISCORD_REST_TIMEOUT_MS } from "../proxy-request-client.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { registerDiscordListener } from "./listeners.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";

describe("Discord provider startup", () => {
  beforeEach(() => {
    registerVoiceClientSpy.mockReset();
    waitForRegistration.mockReset().mockReturnValue(undefined);
    vi.mocked(registerDiscordListener).mockClear();
    vi.mocked(createDiscordGatewayPlugin)
      .mockReset()
      .mockReturnValue({ id: "gateway" } as never);
    vi.mocked(createDiscordGatewaySupervisor)
      .mockReset()
      .mockReturnValue({ shutdown: vi.fn(), handleError: vi.fn() } as never);
    vi.mocked(createDiscordAutoPresenceController)
      .mockReset()
      .mockReturnValue({
        enabled: false,
        start: vi.fn(),
        stop: vi.fn(),
        refresh: vi.fn(),
      } as never);
  });

  function createMonitorClient(
    overrides: Partial<Parameters<typeof createDiscordMonitorClient>[0]> = {},
  ) {
    return createDiscordMonitorClient({
      scheduler: createTestPluginServiceScheduler(),
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: false,
      discordConfig: {},
      runtime: createRuntimeSpies(),
      createClient: (options, handlers, plugins) => new Client(options, handlers, plugins),
      isDisallowedIntentsError: () => false,
      ...overrides,
    });
  }

  it("registers voice after gateway setup and awaits registration before supervision", async () => {
    const gatewayPlugin = { id: "gateway", registerClient: vi.fn() };
    const registration = createDeferred<void>();
    waitForRegistration.mockReturnValue(registration.promise);
    const gatewaySupervisor = { shutdown: vi.fn(), handleError: vi.fn() };
    vi.mocked(createDiscordGatewayPlugin).mockReturnValue(gatewayPlugin as never);
    vi.mocked(createDiscordGatewaySupervisor).mockReturnValue(gatewaySupervisor as never);
    const pending = createMonitorClient({ voiceEnabled: true });
    await Promise.resolve();
    expect(waitForRegistration).toHaveBeenCalledWith(gatewayPlugin);
    expect(createDiscordGatewaySupervisor).not.toHaveBeenCalled();
    registration.resolve();
    const result = await pending;
    expect(registerVoiceClientSpy).toHaveBeenCalledOnce();
    expect(registerVoiceClientSpy).toHaveBeenCalledWith(result.client);
    expect(createDiscordGatewaySupervisor).toHaveBeenCalledOnce();
    expect(result.gatewaySupervisor).toBe(gatewaySupervisor);
  });

  it("passes REST timeout options and fetch to internal Discord REST", async () => {
    const restFetch = vi.fn<typeof fetch>();
    const { client } = await createMonitorClient({ restFetch });
    expect(client.options.requestOptions).toEqual({
      timeout: DISCORD_REST_TIMEOUT_MS,
      fetch: restFetch,
    });
  });

  it("registers and stops presence lifecycle listeners with reactions initially disabled", async () => {
    const stop = registerDiscordMonitorListeners({
      cfg: {},
      client: { listeners: [] },
      accountId: "default",
      discordConfig: { intents: { presence: true } },
      runtime: createRuntimeSpies(),
      botUserId: "bot-1",
      dmEnabled: false,
      groupDmEnabled: false,
      groupDmChannels: [],
      dmPolicy: "disabled",
      allowFrom: [],
      groupPolicy: "allowlist",
      guildEntries: { "guild-1": { id: "guild-1", reactionNotifications: "off" } },
      logger: createSubsystemLogger("discord-test"),
      messageHandler: vi.fn(async () => {}),
    });
    expect(
      vi.mocked(registerDiscordListener).mock.calls.map((call) => {
        const listener = call[1] as { type?: string };
        return listener.type;
      }),
    ).toEqual([
      "interaction",
      "message",
      "GUILD_CREATE",
      "reaction-add",
      "reaction-remove",
      "thread-update",
      "thread-ready",
      "thread-delete",
      "presence",
      "presence-guild-create",
      "presence-guild-delete",
      "presence-ready",
    ]);
    await stop();
    expect(stopPresenceListener).toHaveBeenCalledOnce();
  });

  it("derives the bot id from a token without calling /users/@me", async () => {
    const fetchUser = vi.fn(async () => {
      throw new Error("network should not be used");
    });
    const logStartupPhase = vi.fn();
    const botId = "1477179610322964541";
    await expect(
      fetchDiscordBotIdentity({
        client: { fetchUser } as never,
        token: `${Buffer.from(botId).toString("base64")}.GhIiP9.vU1xEpJ6NjFm`,
        runtime: createRuntimeSpies(),
        logStartupPhase,
      }),
    ).resolves.toEqual({ botUserId: botId, botUserName: undefined });
    expect(fetchUser).not.toHaveBeenCalled();
    expect(logStartupPhase).toHaveBeenCalledWith(
      "fetch-bot-identity:done",
      `botUserId=${botId} botUserName=<missing> source=token`,
    );
  });
});
