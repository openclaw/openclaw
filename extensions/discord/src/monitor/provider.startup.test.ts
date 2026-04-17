import type { Client, Plugin } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";

const { registerVoiceClientSpy } = vi.hoisted(() => ({
  registerVoiceClientSpy: vi.fn(),
}));

vi.mock("@buape/carbon/voice", () => ({
  VoicePlugin: class VoicePlugin {
    id = "voice";

    registerClient(client: {
      getPlugin: (id: string) => unknown;
      registerListener: (listener: object) => object;
      unregisterListener: (listener: object) => boolean;
    }) {
      registerVoiceClientSpy(client);
      if (!client.getPlugin("gateway")) {
        throw new Error("gateway plugin missing");
      }
      client.registerListener({ type: "legacy-voice-listener" });
    }
  },
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  isDangerousNameMatchingEnabled: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalString: (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  },
}));

vi.mock("../proxy-request-client.js", () => ({
  createDiscordRequestClient: vi.fn(),
}));

vi.mock("./auto-presence.js", () => ({
  createDiscordAutoPresenceController: vi.fn(),
}));

vi.mock("./gateway-plugin.js", () => ({
  createDiscordGatewayPlugin: vi.fn(),
}));

vi.mock("./gateway-supervisor.js", () => ({
  createDiscordGatewaySupervisor: vi.fn(),
}));

vi.mock("./listeners.js", () => ({
  DiscordMessageListener: function DiscordMessageListener() {},
  DiscordPresenceListener: function DiscordPresenceListener() {},
  DiscordReactionListener: function DiscordReactionListener() {},
  DiscordReactionRemoveListener: function DiscordReactionRemoveListener() {},
  DiscordThreadUpdateListener: function DiscordThreadUpdateListener() {},
  registerDiscordListener: vi.fn(),
}));

vi.mock("./presence.js", () => ({
  resolveDiscordPresenceUpdate: vi.fn(() => undefined),
}));

import { createDiscordMonitorClient, fetchDiscordBotIdentity } from "./provider.startup.js";

describe("createDiscordMonitorClient", () => {
  it("adds listener compat for legacy voice plugins", () => {
    registerVoiceClientSpy.mockReset();

    const gatewayPlugin = {
      id: "gateway",
      registerClient: vi.fn(),
      registerRoutes: vi.fn(),
    } as Plugin;

    const result = createDiscordMonitorClient({
      accountId: "default",
      applicationId: "app-1",
      token: "token-1",
      commands: [],
      components: [],
      modals: [],
      voiceEnabled: true,
      discordConfig: {},
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      createClient: (_options, handlers, plugins = []) => {
        const pluginRegistry = plugins.map((plugin) => ({ id: plugin.id, plugin }));
        return {
          listeners: [...(handlers.listeners ?? [])],
          plugins: pluginRegistry,
          getPlugin: (id: string) => pluginRegistry.find((entry) => entry.id === id)?.plugin,
        } as Client;
      },
      createGatewayPlugin: () => gatewayPlugin as never,
      createGatewaySupervisor: () => ({ shutdown: vi.fn(), handleError: vi.fn() }) as never,
      createAutoPresenceController: () =>
        ({
          enabled: false,
          start: vi.fn(),
          stop: vi.fn(),
          refresh: vi.fn(),
          runNow: vi.fn(),
        }) as never,
      isDisallowedIntentsError: () => false,
    });

    expect(registerVoiceClientSpy).toHaveBeenCalledTimes(1);
    expect(result.client.listeners).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "legacy-voice-listener" })]),
    );
  });
});

describe("fetchDiscordBotIdentity", () => {
  const makeRuntime = () =>
    ({
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    }) as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["runtime"];

  it("returns identity on success", async () => {
    const logStartupPhase = vi.fn();
    const client = {
      fetchUser: vi.fn().mockResolvedValue({ id: "bot-123", username: "openclaw-bot" }),
    } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"];
    const result = await fetchDiscordBotIdentity({
      client,
      runtime: makeRuntime(),
      logStartupPhase,
    });
    expect(result).toEqual({ botUserId: "bot-123", botUserName: "openclaw-bot" });
    expect(logStartupPhase).toHaveBeenCalledWith("fetch-bot-identity:start");
  });

  it("rethrows when fetchUser rejects so the supervisor can restart", async () => {
    const runtime = makeRuntime();
    const logStartupPhase = vi.fn();
    const failure = new Error("network down");
    const client = {
      fetchUser: vi.fn().mockRejectedValue(failure),
    } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"];
    await expect(
      fetchDiscordBotIdentity({ client, runtime, logStartupPhase }),
    ).rejects.toBe(failure);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("failed to fetch bot identity"));
    expect(logStartupPhase).toHaveBeenCalledWith("fetch-bot-identity:error", expect.any(String));
  });

  it("throws when fetchUser resolves without an id (prevents degraded mention-gating)", async () => {
    const runtime = makeRuntime();
    const logStartupPhase = vi.fn();
    const client = {
      fetchUser: vi.fn().mockResolvedValue({ username: "openclaw-bot" }),
    } as unknown as Parameters<typeof fetchDiscordBotIdentity>[0]["client"];
    await expect(
      fetchDiscordBotIdentity({ client, runtime, logStartupPhase }),
    ).rejects.toThrow(/no id/);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("no id"));
  });
});
