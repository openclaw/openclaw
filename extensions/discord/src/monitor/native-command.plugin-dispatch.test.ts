import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import * as dispatcherModule from "../../../../src/auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import * as pluginCommandsModule from "../../../../src/plugins/commands.js";
import { clearPluginCommands, registerPluginCommand } from "../../../../src/plugins/commands.js";
import { createDiscordNativeCommand } from "./native-command.js";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type ResolveConfiguredAcpBindingRecordFn =
  typeof import("../../../../src/acp/persistent-bindings.js").resolveConfiguredAcpBindingRecord;
type EnsureConfiguredAcpBindingSessionFn =
  typeof import("../../../../src/acp/persistent-bindings.js").ensureConfiguredAcpBindingSession;

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingRecord: vi.fn<ResolveConfiguredAcpBindingRecordFn>(() => null),
  ensureConfiguredAcpBindingSession: vi.fn<EnsureConfiguredAcpBindingSessionFn>(async () => ({
    ok: true,
    sessionKey: "agent:codex:acp:binding:discord:default:seed",
  })),
}));

vi.mock("../../../../src/acp/persistent-bindings.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/acp/persistent-bindings.js")>();
  return {
    ...actual,
    resolveConfiguredAcpBindingRecord: persistentBindingMocks.resolveConfiguredAcpBindingRecord,
    ensureConfiguredAcpBindingSession: persistentBindingMocks.ensureConfiguredAcpBindingSession,
  };
});

function createInteraction(params?: {
  channelType?: ChannelType;
  channelId?: string;
  guildId?: string;
  guildName?: string;
}): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: "owner",
    username: "tester",
    globalName: "Tester",
    channelType: params?.channelType ?? ChannelType.DM,
    channelId: params?.channelId ?? "dm-1",
    guildId: params?.guildId ?? null,
    guildName: params?.guildName,
    interactionId: "interaction-1",
  });
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
      },
    },
  } as OpenClawConfig;
}

function createStatusCommand(cfg: OpenClawConfig) {
  const commandSpec: NativeCommandSpec = {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  };
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function setConfiguredBinding(channelId: string, boundSessionKey: string) {
  persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue({
    spec: {
      channel: "discord",
      accountId: "default",
      conversationId: channelId,
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: `config:acp:discord:default:${channelId}`,
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: channelId,
      },
      status: "active",
      boundAt: 0,
    },
  });
  persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
    ok: true,
    sessionKey: boundSessionKey,
  });
}

function createDispatchSpy() {
  return vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
    counts: {
      final: 1,
      block: 0,
      tool: 0,
    },
  } as never);
}

function expectBoundSessionDispatch(
  dispatchSpy: ReturnType<typeof createDispatchSpy>,
  boundSessionKey: string,
) {
  expect(dispatchSpy).toHaveBeenCalledTimes(1);
  const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
    ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
  };
  expect(dispatchCall.ctx?.SessionKey).toBe(boundSessionKey);
  expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
  expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
  expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).toHaveBeenCalledTimes(1);
}

async function expectBoundStatusCommandDispatch(params: {
  cfg: OpenClawConfig;
  interaction: MockCommandInteraction;
  channelId: string;
  boundSessionKey: string;
}) {
  const command = createStatusCommand(params.cfg);
  setConfiguredBinding(params.channelId, params.boundSessionKey);

  vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
  const dispatchSpy = createDispatchSpy();

  await (command as { run: (interaction: unknown) => Promise<void> }).run(
    params.interaction as unknown,
  );

  expectBoundSessionDispatch(dispatchSpy, params.boundSessionKey);
}

describe("Discord native plugin command dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPluginCommands();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReset();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockReset();
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:discord:default:seed",
    });
  });

  it("executes plugin commands from the real registry through the native Discord command path", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "pair",
      description: "Pair",
      acceptsArgs: true,
    };
    const command = createDiscordNativeCommand({
      command: commandSpec,
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createInteraction();

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(
      Object.assign(interaction, {
        options: {
          getString: () => "now",
          getBoolean: () => null,
          getFocused: () => "",
        },
      }) as unknown,
    );

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "paired:now" }),
    );
  });

  it("executes matched plugin commands directly without invoking the agent dispatcher", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const command = createDiscordNativeCommand({
      command: commandSpec,
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createInteraction();
    const pluginMatch = {
      command: {
        name: "cron_jobs",
        description: "List cron jobs",
        pluginId: "cron-jobs",
        acceptsArgs: false,
        handler: vi.fn().mockResolvedValue({ text: "jobs" }),
      },
      args: undefined,
    };

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(
      pluginMatch as ReturnType<typeof pluginCommandsModule.matchPluginCommand>,
    );
    const executeSpy = vi
      .spyOn(pluginCommandsModule, "executePluginCommand")
      .mockResolvedValue({ text: "direct plugin output" });
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: "direct plugin output" }),
    );
  });

  it("routes native slash commands through configured ACP Discord channel bindings", async () => {
    const guildId = "1459246755253325866";
    const channelId = "1478836151241412759";
    const boundSessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
          },
          acp: {
            mode: "persistent",
          },
        },
      ],
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId,
      guildId,
      guildName: "Ops",
    });

    await expectBoundStatusCommandDispatch({
      cfg,
      interaction,
      channelId,
      boundSessionKey,
    });
  });

  it("falls back to the routed slash and channel session keys when no bound session exists", async () => {
    const guildId = "1459246755253325866";
    const channelId = "1478836151241412759";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      bindings: [
        {
          agentId: "qwen",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "channel", id: channelId },
            guildId,
          },
        },
      ],
      channels: {
        discord: {
          guilds: {
            [guildId]: {
              channels: {
                [channelId]: { allow: true, requireMention: false },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const command = createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId,
      guildId,
      guildName: "Ops",
    });

    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
    };
    expect(dispatchCall.ctx?.SessionKey).toBe("agent:qwen:discord:slash:owner");
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(
      "agent:qwen:discord:channel:1478836151241412759",
    );
    expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).not.toHaveBeenCalled();
  });

  it("routes Discord DM native slash commands through configured ACP bindings", async () => {
    const channelId = "dm-1";
    const boundSessionKey = "agent:codex:acp:binding:discord:default:dmfeedface";
    const cfg = {
      commands: {
        useAccessGroups: false,
      },
      bindings: [
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "discord",
            accountId: "default",
            peer: { kind: "direct", id: channelId },
          },
          acp: {
            mode: "persistent",
          },
        },
      ],
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
        },
      },
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelType: ChannelType.DM,
      channelId,
    });

    await expectBoundStatusCommandDispatch({
      cfg,
      interaction,
      channelId,
      boundSessionKey,
    });
  });
});
