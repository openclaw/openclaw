import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "../../../src/channels/plugins/types.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import type { ResolvedDiscordAccount } from "./accounts.js";
import { discordPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { setDiscordRuntime } from "./runtime.js";

const probeDiscordMock = vi.hoisted(() => vi.fn());
const monitorDiscordProviderMock = vi.hoisted(() => vi.fn());
const auditDiscordChannelPermissionsMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe.js")>();
  return {
    ...actual,
    probeDiscord: probeDiscordMock,
  };
});

vi.mock("./monitor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor.js")>();
  return {
    ...actual,
    monitorDiscordProvider: monitorDiscordProviderMock,
  };
});

vi.mock("./audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit.js")>();
  return {
    ...actual,
    auditDiscordChannelPermissions: auditDiscordChannelPermissionsMock,
  };
});

function createCfg(): OpenClawConfig {
  return {
    channels: {
      discord: {
        enabled: true,
        token: "discord-token",
      },
    },
  } as OpenClawConfig;
}

function createStartAccountCtx(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: ReturnType<typeof createRuntimeEnv>;
}): ChannelGatewayContext<ResolvedDiscordAccount> {
  const account = discordPlugin.config.resolveAccount(
    params.cfg,
    params.accountId,
  ) as ResolvedDiscordAccount;
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.accountId,
    configured: true,
    enabled: true,
    running: false,
  };
  return {
    accountId: params.accountId,
    account,
    cfg: params.cfg,
    runtime: params.runtime,
    abortSignal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () => snapshot,
    setStatus: vi.fn(),
  };
}

afterEach(() => {
  probeDiscordMock.mockReset();
  monitorDiscordProviderMock.mockReset();
  auditDiscordChannelPermissionsMock.mockReset();
});

describe("discordPlugin outbound", () => {
  it("forwards mediaLocalRoots to sendMessageDiscord", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:123",
      text: "hi",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m1" });
  });

  it("uses direct Discord probe helpers for status probes", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    setDiscordRuntime({
      channel: {
        discord: {
          probeDiscord: runtimeProbeDiscord,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime);
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Bob" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });

    const cfg = createCfg();
    const account = discordPlugin.config.resolveAccount(cfg, "default");

    await discordPlugin.status!.probeAccount!({
      account,
      timeoutMs: 5000,
      cfg,
    });

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 5000, {
      includeApplication: true,
    });
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
  });

  it("uses direct Discord startup helpers before monitoring", async () => {
    const runtimeProbeDiscord = vi.fn(async () => {
      throw new Error("runtime Discord probe should not be used");
    });
    const runtimeMonitorDiscordProvider = vi.fn(async () => {
      throw new Error("runtime Discord monitor should not be used");
    });
    setDiscordRuntime({
      channel: {
        discord: {
          probeDiscord: runtimeProbeDiscord,
          monitorDiscordProvider: runtimeMonitorDiscordProvider,
        },
      },
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime);
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "Bob" },
      application: {
        intents: {
          messageContent: "limited",
          guildMembers: "disabled",
          presence: "disabled",
        },
      },
      elapsedMs: 1,
    });
    monitorDiscordProviderMock.mockResolvedValue(undefined);

    const cfg = createCfg();
    await discordPlugin.gateway!.startAccount!(
      createStartAccountCtx({
        cfg,
        accountId: "default",
        runtime: createRuntimeEnv(),
      }),
    );

    expect(probeDiscordMock).toHaveBeenCalledWith("discord-token", 2500, {
      includeApplication: true,
    });
    expect(monitorDiscordProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "discord-token",
        accountId: "default",
      }),
    );
    expect(runtimeProbeDiscord).not.toHaveBeenCalled();
    expect(runtimeMonitorDiscordProvider).not.toHaveBeenCalled();
  });
});

describe("discordPlugin gateway startAccount error handling", () => {
  it("catches monitorDiscordProvider errors and disables account instead of crashing", async () => {
    setDiscordRuntime({
      channel: { discord: {} },
      logging: { shouldLogVerbose: () => false },
    } as unknown as PluginRuntime);
    probeDiscordMock.mockResolvedValue({
      ok: true,
      bot: { username: "TestBot" },
      application: { intents: { messageContent: "enabled" } },
      elapsedMs: 1,
    });
    monitorDiscordProviderMock.mockRejectedValue(
      new Error("Gateway closed with code 4014 (Disallowed intents)"),
    );

    const cfg = createCfg();
    const ctx = createStartAccountCtx({
      cfg,
      accountId: "default",
      runtime: createRuntimeEnv(),
    });

    // Should NOT throw — error is caught internally
    await discordPlugin.gateway!.startAccount!(ctx);

    expect(ctx.log?.warn).toHaveBeenCalledWith(expect.stringContaining("Discord provider failed"));
    expect(ctx.log?.warn).toHaveBeenCalledWith(expect.stringContaining("4014"));
    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        running: false,
        lastError: expect.stringContaining("4014"),
      }),
    );
  });

  it("handles non-Error thrown values gracefully", async () => {
    setDiscordRuntime({
      channel: { discord: {} },
      logging: { shouldLogVerbose: () => false },
    } as unknown as PluginRuntime);
    probeDiscordMock.mockResolvedValue({ ok: false, elapsedMs: 1 });
    monitorDiscordProviderMock.mockRejectedValue("raw string error");

    const cfg = createCfg();
    const ctx = createStartAccountCtx({
      cfg,
      accountId: "default",
      runtime: createRuntimeEnv(),
    });

    await discordPlugin.gateway!.startAccount!(ctx);

    expect(ctx.log?.warn).toHaveBeenCalledWith(expect.stringContaining("unknown error"));
    expect(ctx.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        running: false,
        lastError: "unknown error",
      }),
    );
  });
});

describe("discordPlugin groups", () => {
  it("uses plugin-owned group policy resolvers", () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          guilds: {
            guild1: {
              requireMention: false,
              tools: { allow: ["message.guild"] },
              channels: {
                "123": {
                  requireMention: true,
                  tools: { allow: ["message.channel"] },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      discordPlugin.groups?.resolveRequireMention?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toBe(true);
    expect(
      discordPlugin.groups?.resolveToolPolicy?.({
        cfg,
        groupSpace: "guild1",
        groupId: "123",
      }),
    ).toEqual({ allow: ["message.channel"] });
  });
});
