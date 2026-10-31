import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, expect, it, vi } from "vitest";
import { Client } from "../internal/client.js";

const { registerVoiceClientSpy, waitForRegistration, stopPresenceListener, gateway, supervisor } =
  vi.hoisted(() => ({
    registerVoiceClientSpy: vi.fn(),
    stopPresenceListener: vi.fn(async () => {}),
    waitForRegistration: vi.fn(),
    gateway: { id: "gateway", registerClient: vi.fn(), disconnect: vi.fn() },
    supervisor: { shutdown: vi.fn(), handleError: vi.fn(), dispose: vi.fn() },
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
// mock-isolation: startup tests control presence without starting live timers.
vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: vi.fn(() => ({
    enabled: false,
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
  })),
}));
// mock-isolation: startup tests own the synthetic gateway registration barrier.
vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: vi.fn(() => gateway),
  waitForDiscordGatewayPluginRegistration: waitForRegistration,
}));
// mock-isolation: observe startup cleanup without starting a live supervisor.
vi.mock("./gateway-supervisor.js", () => ({
  createDiscordGatewaySupervisor: vi.fn(() => supervisor),
}));
vi.mock("./listeners.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./listeners.js")>()),
  DiscordPresenceListener: class {
    stop = stopPresenceListener;
  },
}));

import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { DISCORD_REST_TIMEOUT_MS } from "../internal/rest.js";
import { createDiscordAutoPresenceController } from "./auto-presence.js";
import { createDiscordGatewaySupervisor } from "./gateway-supervisor.js";
import {
  DiscordPresenceListener,
  DiscordReactionListener,
  DiscordReactionRemoveListener,
} from "./listeners.js";
import {
  createDiscordMonitorClient,
  fetchDiscordBotIdentity,
  registerDiscordMonitorListeners,
} from "./provider.startup.js";

beforeEach(() => {
  vi.clearAllMocks();
  gateway.disconnect.mockReset();
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
    isDisallowedIntentsError: () => false,
    ...overrides,
  });
}

it("registers voice after gateway setup and awaits registration before supervision", async () => {
  const registration = createDeferred<void>();
  waitForRegistration.mockReturnValueOnce(registration.promise);
  const pending = createMonitorClient({ voiceEnabled: true });
  await Promise.resolve();
  expect(waitForRegistration).toHaveBeenCalledWith(gateway);
  expect(createDiscordGatewaySupervisor).not.toHaveBeenCalled();
  registration.resolve();
  const result = await pending;
  expect(registerVoiceClientSpy).toHaveBeenCalledExactlyOnceWith(result.client);
  expect(result.gatewaySupervisor).toBe(supervisor);
});

it("releases the gateway and supervisor when restart closes the scheduler during registration", async () => {
  const { createDiscordAutoPresenceController: createPresence } =
    await vi.importActual<typeof import("./auto-presence.js")>("./auto-presence.js");
  const registration = createDeferred<void>();
  const scheduler = createTestPluginServiceScheduler();
  waitForRegistration.mockReturnValueOnce(registration.promise);
  vi.mocked(createDiscordAutoPresenceController).mockImplementationOnce(createPresence);
  const pending = createMonitorClient({ scheduler });
  await scheduler.stop();
  registration.resolve();

  await expect(pending).rejects.toThrow("Plugin service scheduler is closed");
  expect(gateway.disconnect).toHaveBeenCalledOnce();
  expect(supervisor.dispose).toHaveBeenCalledOnce();
});

it("keeps the startup failure when disconnect fails", async () => {
  const failure = new Error("registration failed");
  const runtime = createRuntimeSpies();
  waitForRegistration.mockRejectedValueOnce(failure);
  gateway.disconnect.mockImplementationOnce(() => {
    throw new Error("disconnect failed");
  });

  await expect(createMonitorClient({ runtime })).rejects.toBe(failure);
  expect(gateway.disconnect).toHaveBeenCalledOnce();
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("failed to disconnect gateway during startup cleanup"),
  );
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
  const listeners: Client["listeners"] = [];
  const stop = registerDiscordMonitorListeners({
    cfg: {},
    client: { listeners },
    accountId: "default",
    discordConfig: { intents: { presence: true } },
    runtime: createRuntimeSpies(),
    botUserId: "bot-1",
    dmEnabled: false,
    groupDmEnabled: false,
    dmPolicy: "disabled",
    groupPolicy: "allowlist",
    guildEntries: { "guild-1": { id: "guild-1", reactionNotifications: "off" } },
    logger: createSubsystemLogger("discord-test"),
    messageHandler: vi.fn(async () => {}),
  });
  expect(listeners).toEqual(
    expect.arrayContaining([
      expect.any(DiscordPresenceListener),
      expect.any(DiscordReactionListener),
      expect.any(DiscordReactionRemoveListener),
    ]),
  );
  await stop();
  expect(stopPresenceListener).toHaveBeenCalledOnce();
});

it("derives the bot id from a token without calling /users/@me", async () => {
  const fetchUser = vi.fn(async () => {
    throw new Error("network should not be used");
  });
  const botId = "1477179610322964541";
  await expect(
    fetchDiscordBotIdentity({
      client: { fetchUser },
      token: `${Buffer.from(botId).toString("base64")}.GhIiP9.vU1xEpJ6NjFm`,
      runtime: createRuntimeSpies(),
    }),
  ).resolves.toEqual({ botUserId: botId, botUserName: undefined });
  expect(fetchUser).not.toHaveBeenCalled();
});
