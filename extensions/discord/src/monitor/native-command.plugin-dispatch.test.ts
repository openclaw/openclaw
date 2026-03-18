import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import * as dispatcherModule from "../../../../src/auto-reply/reply/provider-dispatcher.js";
import type { ChatType } from "../../../../src/channels/chat-type.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import * as pluginCommandsModule from "../../../../src/plugins/commands.js";
import { clearPluginCommands, registerPluginCommand } from "../../../../src/plugins/commands.js";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type ResolveConfiguredBindingRouteFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").resolveConfiguredBindingRoute;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").ensureConfiguredBindingRouteReady;

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingRecord: vi.fn<ResolveConfiguredBindingRouteFn>((params) => ({
    bindingResolution: null,
    route: params.route,
  })),
  ensureConfiguredAcpBindingSession: vi.fn<EnsureConfiguredBindingRouteReadyFn>(async () => ({
    ok: true,
  })),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    resolveConfiguredBindingRoute: persistentBindingMocks.resolveConfiguredAcpBindingRecord,
    ensureConfiguredBindingRouteReady: persistentBindingMocks.ensureConfiguredAcpBindingSession,
  };
});

import { createDiscordNativeCommand } from "./native-command.js";

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

function createNativeCommand(cfg: OpenClawConfig, commandSpec: NativeCommandSpec) {
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

function createPluginCommand(params: { cfg: OpenClawConfig; name: string }) {
  return createDiscordNativeCommand({
    command: {
      name: params.name,
      description: "Pair",
      acceptsArgs: true,
    } satisfies NativeCommandSpec,
    cfg: params.cfg,
    discordConfig: params.cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function registerPairPlugin(params?: { discordNativeName?: string }) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      ...(params?.discordNativeName
        ? {
            nativeNames: {
              telegram: "pair_device",
              discord: params.discordNativeName,
            },
          }
        : {}),
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
    }),
  ).toEqual({ ok: true });
}

async function expectPairCommandReply(params: {
  cfg: OpenClawConfig;
  commandName: string;
  interaction: MockCommandInteraction;
}) {
  const command = createPluginCommand({
    cfg: params.cfg,
    name: params.commandName,
  });
  const dispatchSpy = vi
    .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
    .mockResolvedValue({} as never);

  await (command as { run: (interaction: unknown) => Promise<void> }).run(
    Object.assign(params.interaction, {
      options: {
        getString: () => "now",
        getBoolean: () => null,
        getFocused: () => "",
      },
    }) as unknown,
  );

  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(params.interaction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: "paired:now" }),
  );
}

function createStatusCommand(cfg: OpenClawConfig) {
  return createNativeCommand(cfg, {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  });
}

function resolveConversationFromParams(params: Parameters<ResolveConfiguredBindingRouteFn>[0]) {
  if ("conversation" in params) {
    return params.conversation;
  }
  return {
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    ...(params.parentConversationId ? { parentConversationId: params.parentConversationId } : {}),
  };
}

function createConfiguredBindingResolution(params: {
  conversation: ReturnType<typeof resolveConversationFromParams>;
  boundSessionKey: string;
}) {
  const peerKind: ChatType = params.conversation.conversationId.startsWith("dm-")
    ? "direct"
    : "channel";
  const configuredBinding = {
    spec: {
      channel: "discord" as const,
      accountId: params.conversation.accountId,
      conversationId: params.conversation.conversationId,
      ...(params.conversation.parentConversationId
        ? { parentConversationId: params.conversation.parentConversationId }
        : {}),
      agentId: "codex",
      mode: "persistent" as const,
    },
    record: {
      bindingId: `config:acp:discord:${params.conversation.accountId}:${params.conversation.conversationId}`,
      targetSessionKey: params.boundSessionKey,
      targetKind: "session" as const,
      conversation: params.conversation,
      status: "active" as const,
      boundAt: 0,
    },
  };
  return {
    conversation: params.conversation,
    compiledBinding: {
      channel: "discord" as const,
      binding: {
        type: "acp" as const,
        agentId: "codex",
        match: {
          channel: "discord",
          accountId: params.conversation.accountId,
          peer: {
            kind: peerKind,
            id: params.conversation.conversationId,
          },
        },
        acp: {
          mode: "persistent" as const,
        },
      },
      bindingConversationId: params.conversation.conversationId,
      target: {
        conversationId: params.conversation.conversationId,
        ...(params.conversation.parentConversationId
          ? { parentConversationId: params.conversation.parentConversationId }
          : {}),
      },
      agentId: "codex",
      provider: {
        compileConfiguredBinding: () => ({
          conversationId: params.conversation.conversationId,
          ...(params.conversation.parentConversationId
            ? { parentConversationId: params.conversation.parentConversationId }
            : {}),
        }),
        matchInboundConversation: () => ({
          conversationId: params.conversation.conversationId,
          ...(params.conversation.parentConversationId
            ? { parentConversationId: params.conversation.parentConversationId }
            : {}),
        }),
      },
      targetFactory: {
        driverId: "acp" as const,
        materialize: () => ({
          record: configuredBinding.record,
          statefulTarget: {
            kind: "stateful" as const,
            driverId: "acp",
            sessionKey: params.boundSessionKey,
            agentId: "codex",
          },
        }),
      },
    },
    match: {
      conversationId: params.conversation.conversationId,
      ...(params.conversation.parentConversationId
        ? { parentConversationId: params.conversation.parentConversationId }
        : {}),
    },
    record: configuredBinding.record,
    statefulTarget: {
      kind: "stateful" as const,
      driverId: "acp",
      sessionKey: params.boundSessionKey,
      agentId: "codex",
    },
  };
}

function setConfiguredBinding(channelId: string, boundSessionKey: string) {
  persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockImplementation((params) => {
    const conversation = resolveConversationFromParams(params);
    const bindingResolution = createConfiguredBindingResolution({
      conversation: {
        ...conversation,
        conversationId: channelId,
      },
      boundSessionKey,
    });
    return {
      bindingResolution,
      boundSessionKey,
      boundAgentId: "codex",
      route: {
        ...params.route,
        agentId: "codex",
        sessionKey: boundSessionKey,
        matchedBy: "binding.channel",
      },
    };
  });
  persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
    ok: true,
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
    vi.clearAllMocks();
    clearPluginCommands();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReset();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockImplementation((params) => ({
      bindingResolution: null,
      route: params.route,
    }));
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockReset();
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
    });
  });

  it("executes plugin commands from the real registry through the native Discord command path", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();

    registerPairPlugin();
    await expectPairCommandReply({
      cfg,
      commandName: "pair",
      interaction,
    });
  });

  it("round-trips Discord native aliases through the real plugin registry", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();

    registerPairPlugin({ discordNativeName: "pairdiscord" });
    await expectPairCommandReply({
      cfg,
      commandName: "pairdiscord",
      interaction,
    });
  });

  it("blocks unauthorized Discord senders before requireAuth:false plugin commands execute", async () => {
    const cfg = {
      commands: {
        allowFrom: {
          discord: ["user:123456789012345678"],
        },
      },
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: {
                "234567890123456789": {
                  allow: true,
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
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
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "234567890123456789",
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    interaction.user.id = "999999999999999999";
    interaction.options.getString.mockReturnValue("now");

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `open:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

    const executeSpy = vi.spyOn(pluginCommandsModule, "executePluginCommand");
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      }),
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

  it("allows recovery commands through configured ACP bindings even when ensure fails", async () => {
    const guildId = "1459246755253325866";
    const channelId = "1479098716916023408";
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
    const command = createNativeCommand(cfg, {
      name: "new",
      description: "Start a new session.",
      acceptsArgs: true,
    });

    setConfiguredBinding(channelId, boundSessionKey);
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: false,
      error: "acpx exited with code 1",
    });
    vi.spyOn(pluginCommandsModule, "matchPluginCommand").mockReturnValue(null);
    const dispatchSpy = createDispatchSpy();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchCall = dispatchSpy.mock.calls[0]?.[0] as {
      ctx?: { SessionKey?: string; CommandTargetSessionKey?: string };
    };
    expect(dispatchCall.ctx?.SessionKey).toBe(boundSessionKey);
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
    expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Configured ACP binding is unavailable right now. Please try again.",
      }),
    );
  });
});
