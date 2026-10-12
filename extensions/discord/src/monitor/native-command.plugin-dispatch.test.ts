// Discord tests cover native command.plugin dispatch plugin behavior.
import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import * as commandStatus from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  createPluginCommandRuntime,
  PLUGIN_COMMAND_DISPATCH,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { defineThrowingDiscordChannelGetter } from "../test-support/partial-channel.js";
import { dispatchDiscordNativeAgentReply } from "./native-command-agent-reply.js";
import * as nativeCommandRoute from "./native-command-route.js";
import {
  createMockCommandInteraction as createInteraction,
  createRouteState,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
const runtimeModuleMocks = vi.hoisted(() => ({
  pluginCommandHandler: vi.fn(),
  dispatchReplyWithDispatcher: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
  getSessionEntry: vi.fn(),
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: runtimeModuleMocks.recordDeliveredCommandExchange,
}));
let observedNativeTurnDispatcher: unknown;
const getSessionEntry = sessionStore.getSessionEntryAsync;

const dispatchChannelInboundTurnForTest: typeof channelInbound.dispatchChannelInboundTurn = async (
  plan,
) => {
  observedNativeTurnDispatcher = plan.dispatchReplyFromConfig;
  const dispatchResult = await runtimeModuleMocks.dispatchReplyWithDispatcher({
    ctx: plan.ctxPayload,
    cfg: plan.cfg,
    dispatcherOptions: {
      ...plan.dispatcherOptions,
      deliver: "deliver" in plan.delivery ? plan.delivery.deliver : undefined,
      onError: plan.delivery.onError,
    },
    replyOptions: plan.replyOptions,
  });
  return dispatchedTurn(plan, dispatchResult);
};

type DispatchPlan = Pick<
  Parameters<typeof channelInbound.dispatchChannelInboundTurn>[0],
  "ctxPayload" | "route"
>;
type DispatchResult = Extract<
  Awaited<ReturnType<typeof channelInbound.dispatchChannelInboundTurn>>,
  { dispatched: true }
>["dispatchResult"];
function dispatchedTurn(plan: DispatchPlan, dispatchResult: DispatchResult) {
  return {
    admission: { kind: "dispatch" as const },
    dispatched: true as const,
    ctxPayload: plan.ctxPayload,
    routeSessionKey: plan.route.sessionKey,
    dispatchResult,
  };
}
function dispatchAgentReply(
  cfg: OpenClawConfig,
  interaction: MockCommandInteraction,
  suppressReplies = false,
) {
  return dispatchDiscordNativeAgentReply({
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    interaction: interaction as never,
    ctxPayload: { SessionKey: "agent:main:discord:dm:owner" } as never,
    effectiveRoute: {
      accountId: "default",
      agentId: "main",
      sessionKey: "agent:main:discord:dm:owner",
    },
    channelConfig: null,
    mediaLocalRoots: [],
    preferFollowUp: true,
    pluginCommandDispatch: { kind: "non-plugin" },
    suppressReplies,
    log: { error: vi.fn() } as never,
  });
}

function createConfig(): OpenClawConfig {
  return {
    channels: {
      discord: {
        dm: { enabled: true },
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
  } as OpenClawConfig;
}

async function createNativeCommand(
  cfg: OpenClawConfig,
  commandSpec: NativeCommandSpec = {
    name: "new",
    description: "Start a new session.",
    acceptsArgs: true,
  },
  dispatchReplyFromConfig?: Parameters<
    typeof createDiscordNativeCommand
  >[0]["dispatchReplyFromConfig"],
) {
  return createDiscordNativeCommand({
    command: commandSpec,
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
    dispatchReplyFromConfig,
  });
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isObjectValue(value), `${label} should be an object`).toBe(true);
  if (!isObjectValue(value)) {
    throw new Error(`${label} should be an object`);
  }
  return value;
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function firstMockCall(mock: MockCalls, label: string): unknown[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function firstMockArg(mock: MockCalls, label: string) {
  return firstMockCall(mock, label)[0];
}

function expectSingleCallFirstArg(
  mock: MockCalls,
  expected: Record<string, unknown>,
  label = "mock first argument",
): Record<string, unknown> {
  expect(mock.mock.calls).toHaveLength(1);
  const record = requireRecord(firstMockArg(mock, label), label);
  expectFields(record, expected);
  return record;
}

function expectPluginCommandExecution(params: {
  mock: MockCalls;
  commandName: string;
  expected: Record<string, unknown>;
}) {
  const payload = expectSingleCallFirstArg(params.mock, params.expected, "plugin command payload");
  expect(requireRecord(payload.command, "plugin command").name).toBe(params.commandName);
  return payload;
}

function expectFollowUpFields(
  interaction: MockCommandInteraction,
  expected: Record<string, unknown>,
) {
  return expectSingleCallFirstArg(
    interaction.followUp as unknown as MockCalls,
    expected,
    "followUp",
  );
}

function expectNoFollowUpContent(interaction: MockCommandInteraction, content: string) {
  const calls = (interaction.followUp as unknown as MockCalls).mock.calls;
  const matched = calls.some(([payload]) => isObjectValue(payload) && payload.content === content);
  expect(matched).toBe(false);
}

async function createPluginCommand(params: {
  cfg: OpenClawConfig;
  name: string;
  registeredName?: string;
}) {
  const registration = getActivePluginRegistry()?.commands.find(
    (entry) =>
      entry.command.name === (params.registeredName ?? params.name) ||
      entry.command.nativeNames?.discord === params.name,
  );
  if (!registration) {
    throw new Error(`expected plugin command registration ${params.name}`);
  }
  const originalHandler = registration.command.handler;
  registration.command.handler = async (ctx) =>
    await runtimeModuleMocks.pluginCommandHandler({
      ...ctx,
      command: { name: registration.command.name },
      run: () => originalHandler(ctx),
    });
  const candidate = createPluginCommandRuntime()
    .listNativeCandidates("discord")
    .find((entry) => entry.name === params.name);
  if (!candidate) {
    throw new Error(`expected plugin command candidate ${params.name}`);
  }
  return createDiscordNativeCommand({
    command: candidate,
    cfg: params.cfg,
    discordConfig: params.cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

async function createMockPluginNativeCommand(cfg: OpenClawConfig, spec: NativeCommandSpec) {
  expect(
    registerPluginCommand(`test-${spec.name}`, {
      name: spec.name,
      description: spec.description,
      acceptsArgs: spec.acceptsArgs,
      requireAuth: true,
      handler: async () => ({ text: "ok" }),
    }),
  ).toEqual({ ok: true });
  return await createPluginCommand({ cfg, name: spec.name });
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

function registerScopedPairPlugin(
  handler = vi.fn(async ({ args }: { args?: string }) => ({ text: `paired:${args ?? ""}` })),
) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      requiredScopes: ["operator.pairing"],
      handler,
    }),
  ).toEqual({ ok: true });
  return handler;
}

async function createStatusCommand(cfg: OpenClawConfig) {
  return await createNativeCommand(cfg, {
    name: "status",
    description: "Status",
    acceptsArgs: false,
  });
}

function createDispatchSpy() {
  return runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
    counts: {
      final: 1,
      block: 0,
      tool: 0,
    },
  } as never);
}

describe("Discord native plugin command dispatch", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
  });

  afterAll(() => {
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
  });

  beforeEach(() => {
    observedNativeTurnDispatcher = undefined;
    clearRuntimeConfigSnapshot();
    vi.clearAllMocks();
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
    runtimeModuleMocks.pluginCommandHandler.mockReset();
    runtimeModuleMocks.pluginCommandHandler.mockImplementation(
      async (params: { run?: () => Promise<unknown> }) => await params.run?.(),
    );
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockReset();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        final: 1,
        block: 0,
        tool: 0,
      },
    } as never);
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockReset();
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      text: "status reply",
    });
    runtimeModuleMocks.getSessionEntry.mockReset();
    runtimeModuleMocks.getSessionEntry.mockReturnValue(undefined);
    runtimeModuleMocks.recordDeliveredCommandExchange.mockClear();
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(
      dispatchChannelInboundTurnForTest,
    );
    vi.spyOn(commandStatus, "resolveDirectStatusReplyForSession").mockImplementation(
      runtimeModuleMocks.resolveDirectStatusReplyForSession,
    );
    vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
      (params) =>
        createRouteState({
          sessionKey: params.isDirectMessage
            ? `agent:main:discord:dm:${params.directUserId ?? "owner"}`
            : `agent:main:discord:channel:${params.conversationId}`,
          accountId: params.accountId,
        }),
    );
    vi.spyOn(sessionStore, "getSessionEntryAsync").mockImplementation(async (params) =>
      params.agentId !== undefined
        ? runtimeModuleMocks.getSessionEntry(params)
        : getSessionEntry(params),
    );
    vi.spyOn(sessionStore, "getSessionEntryAsync").mockImplementation(async (params) =>
      runtimeModuleMocks.getSessionEntry(params),
    );
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("keeps the owning Gateway dispatcher on a native slash turn", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    const dispatchReplyFromConfig =
      vi.fn<
        NonNullable<Parameters<typeof createDiscordNativeCommand>[0]["dispatchReplyFromConfig"]>
      >();
    const command = await createNativeCommand(
      cfg,
      { name: "new", description: "Start a new session.", acceptsArgs: true },
      dispatchReplyFromConfig,
    );

    await command.run(interaction);

    expect(observedNativeTurnDispatcher).toBe(dispatchReplyFromConfig);
  });

  it("refreshes native command routing config between invocations", async () => {
    const sourceCfg = {
      ...createConfig(),
      session: { dmScope: "main" },
    } as OpenClawConfig;
    const runtimeCfg = {
      ...sourceCfg,
      session: { dmScope: "per-channel-peer" },
    } as OpenClawConfig;
    const resolveRouteState = vi.fn((params: { cfg: OpenClawConfig }) =>
      createRouteState({
        sessionKey:
          params.cfg.session?.dmScope === "per-channel-peer"
            ? "agent:main:discord:direct:owner"
            : "agent:main:main",
      }),
    );
    vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
      resolveRouteState,
    );
    const command = await createStatusCommand(sourceCfg);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(
      createInteraction() as unknown,
    );
    setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
    await (command as { run: (interaction: unknown) => Promise<void> }).run(
      createInteraction() as unknown,
    );

    expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
    expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionKey: "agent:main:discord:direct:owner" }),
    );
  });

  it("carries the built-in catalog winner through the interaction", async () => {
    const cfg = createConfig();
    const pluginHandler = vi.fn(async () => ({ text: "wrong plugin" }));
    getActivePluginRegistry()!.commands.push({
      pluginId: "shadow-plugin",
      source: "test",
      command: {
        name: "help",
        description: "Shadow help",
        channels: ["discord"],
        requireAuth: false,
        handler: pluginHandler,
      },
    });
    const help: NativeCommandSpec = {
      name: "help",
      description: "Show help",
      acceptsArgs: false,
    };
    const command = await createNativeCommand(cfg, help);

    await (command as { run: (interaction: unknown) => Promise<void> }).run(
      createInteraction() as unknown,
    );

    expect(pluginHandler).not.toHaveBeenCalled();
    const dispatchParams = requireRecord(
      firstMockArg(runtimeModuleMocks.dispatchReplyWithDispatcher, "core dispatch"),
      "core dispatch",
    );
    expect(
      (dispatchParams.replyOptions as Record<PropertyKey, unknown>)[PLUGIN_COMMAND_DISPATCH],
    ).toEqual({ kind: "non-plugin" });
  });

  it("passes the configured binding agent to plugin-owned Discord command sessions", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    const pluginSessionKey = "plugin-binding:openclaw-codex-app-server:dm";
    vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
      () => ({
        ...createRouteState({ bound: true, sessionKey: pluginSessionKey, agentId: "main" }),
        configuredBinding: {
          statefulTarget: {
            kind: "stateful",
            driverId: "codex",
            sessionKey: pluginSessionKey,
            agentId: "codex",
          },
        } as never,
      }),
    );
    runtimeModuleMocks.getSessionEntry.mockReturnValue({
      sessionId: "codex-session",
      authProfileOverride: "openai:owner@example.com",
      updatedAt: Date.now(),
    });

    registerPairPlugin();
    const command = await createPluginCommand({
      cfg,
      name: "pair",
    });
    const executeSpy = runtimeModuleMocks.pluginCommandHandler.mockResolvedValue({
      text: "paired:now",
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(
      Object.assign(interaction, {
        options: {
          getString: () => "now",
          getBoolean: () => null,
          getFocused: () => "",
        },
      }) as unknown,
    );

    expectPluginCommandExecution({
      mock: executeSpy,
      commandName: "pair",
      expected: {
        agentId: "codex",
        sessionKey: pluginSessionKey,
      },
    });
    expect(runtimeModuleMocks.getSessionEntry).toHaveBeenCalledWith({
      agentId: "codex",
      sessionKey: pluginSessionKey,
    });
    expect(runtimeModuleMocks.recordDeliveredCommandExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "codex",
        sessionKey: pluginSessionKey,
        expectedSessionId: "codex-session",
        commandText: "/pair now",
        replyText: "paired:now",
      }),
    );
  });

  it.each([
    { sender: "DM allowlist users", allowFrom: ["user:owner"], userId: "owner" },
    {
      sender: "authorized non-owners",
      allowFrom: ["*"],
      userId: "authorized-non-owner",
    },
  ])(
    "does not treat Discord $sender as scoped plugin command owners",
    async ({ allowFrom, userId }) => {
      const cfg = {
        channels: {
          discord: {
            dm: { enabled: true },
            dmPolicy: "open",
            allowFrom,
          },
        },
      } as OpenClawConfig;
      const interaction = createInteraction({ userId });
      interaction.options.getString.mockReturnValue("now");
      const handler = registerScopedPairPlugin();
      const command = await createPluginCommand({ cfg, name: "pair" });

      await command.run(interaction);

      expect(handler).not.toHaveBeenCalled();
      expectFollowUpFields(interaction, {
        content: "⚠️ This command requires gateway scope: operator.pairing.",
      });
      expect(interaction.reply).not.toHaveBeenCalled();
    },
  );

  it("allows generic command owners to run scoped Discord plugin commands without gateway scopes", async () => {
    const cfg = {
      commands: {
        ownerAllowFrom: ["discord:123456789012345678"],
      },
      channels: {
        discord: {
          dm: { enabled: true },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;
    const interaction = createInteraction({ userId: "123456789012345678" });
    interaction.options.getString.mockReturnValue("now");
    const handler = registerScopedPairPlugin();
    const command = await createPluginCommand({ cfg, name: "pair" });

    await command.run(interaction);

    expect(handler).toHaveBeenCalledTimes(1);
    expectFollowUpFields(interaction, { content: "paired:now" });
    expect(interaction.reply).not.toHaveBeenCalled();
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
                  enabled: true,
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
    const command = await createPluginCommand({ cfg, name: commandSpec.name });

    const executeSpy = runtimeModuleMocks.pluginCommandHandler;
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );

    await command.run(interaction);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectFollowUpFields(interaction, {
      content: "You are not authorized to use this command.",
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  for (const { name, ownerAllowFrom } of [
    {
      name: "ignores non-Discord generic command owners when authorizing guild plugin commands",
      ownerAllowFrom: "telegram:123456789",
    },
    {
      name: "keeps non-matching Discord command owners from restricting guild plugin commands",
      ownerAllowFrom: "discord:123456789012345678",
    },
  ]) {
    it(name, async () => {
      const cfg = {
        commands: {
          ownerAllowFrom: [ownerAllowFrom],
        },
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "345678901234567890": {
                channels: {
                  "234567890123456789": {
                    enabled: true,
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
      const executeSpy = runtimeModuleMocks.pluginCommandHandler.mockResolvedValue({
        text: "open:now",
      });
      const command = await createPluginCommand({ cfg, name: commandSpec.name });

      await command.run(interaction);

      expectPluginCommandExecution({
        mock: executeSpy,
        commandName: "pair",
        expected: { args: "now" },
      });
      expectFollowUpFields(interaction, { content: "open:now" });
      expect(interaction.reply).not.toHaveBeenCalled();
    });
  }

  it("rejects group DM slash commands outside dm.groupChannels before dispatch", async () => {
    const cfg = {
      commands: {
        allowFrom: {
          discord: ["user:owner"],
        },
      },
      channels: {
        discord: {
          dmPolicy: "open",
          dm: {
            enabled: true,
            groupEnabled: true,
            groupChannels: ["allowed-group"],
          },
        },
      },
    } as OpenClawConfig;
    const interaction = createInteraction({
      channelType: ChannelType.GroupDM,
      channelId: "blocked-group",
    });
    const dispatchSpy = createDispatchSpy();
    const command = await createStatusCommand(cfg);

    await command.run(interaction);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expectFollowUpFields(interaction, {
      content: "This group DM is not allowed.",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("settles an accepted active-run steer without an empty warning", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: { final: 0, block: 0, tool: 0 },
      queuedFinal: false,
      deferredToActiveRun: "steer",
    } as never);
    const command = await createNativeCommand(cfg, {
      name: "steer",
      description: "Steer an active run.",
      acceptsArgs: true,
    });

    await command.run(interaction);

    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("warns when the inbound turn is dropped before dispatch", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async () => ({
      admission: { kind: "drop", reason: "ingest-null" },
      dispatched: false,
    }));

    const result = await dispatchAgentReply(cfg, interaction);

    expect(result).toEqual({ dispatched: false });
    expectFollowUpFields(interaction, {
      content: "⚠️ Command produced no visible reply.",
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it("settles deliberate command silence without an empty warning", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: { final: 0, block: 0, tool: 0 },
      queuedFinal: false,
      deliberateSilentTerminalReply: true,
    } as never);
    const command = await createNativeCommand(cfg);

    await command.run(interaction);

    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("warns when a final delivery observer does not report its outcome", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
      await plan.delivery.onDelivered?.({ text: "unreported" }, { kind: "final" }, undefined);
      return dispatchedTurn(plan, {
        counts: { final: 0, block: 0, tool: 0 },
        queuedFinal: false,
      });
    });
    const command = await createNativeCommand(cfg);

    await command.run(interaction);

    expectFollowUpFields(interaction, {
      content: "⚠️ Command produced no visible reply.",
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it("settles repeated suppressed finals without an empty warning", async () => {
    const count = 2;
    const cfg = createConfig();
    const interaction = createInteraction();
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
      for (let index = 0; index < count; index += 1) {
        await plan.delivery.onDelivered?.(
          { text: "cancelled" },
          { kind: "final" },
          {
            visibleReplySent: false,
            suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
          },
        );
      }
      return dispatchedTurn(plan, {
        counts: { final: 0, block: 0, tool: 0 },
        queuedFinal: false,
      });
    });
    const command = await createNativeCommand(cfg);

    await command.run(interaction);

    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("preserves a hidden error final and its metadata", async () => {
    const isError = true;
    const cfg = createConfig();
    const interaction = createInteraction();
    interaction.responseState = "deferred";
    const finalReply = setReplyPayloadMetadata(
      { text: "scope-aware model selection result", isError },
      { assistantMessageIndex: 3 },
    );
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
      if (!("deliver" in plan.delivery) || !plan.delivery.deliver) {
        throw new Error("expected direct deliverer");
      }
      const info = { kind: "final" as const };
      const deliveryResult = await plan.delivery.deliver(finalReply, info);
      expect(deliveryResult).toEqual({
        visibleReplySent: false,
        suppression: { reason: "channel_transform" },
      });
      await plan.delivery.onDelivered?.(finalReply, info, deliveryResult);
      return dispatchedTurn(plan, {
        counts: { final: 0, block: 0, tool: 0 },
        queuedFinal: false,
      });
    });

    const result = await dispatchAgentReply(cfg, interaction, true);

    expect(result.hiddenFinalReply).toBe(finalReply);
    expect(result.hiddenFinalReply?.isError).toBe(isError);
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "hook cancellation",
      payload: { text: "cancelled core final" },
      suppression: { reason: "cancelled_by_reply_payload_sending_hook" as const },
    },
    {
      label: "empty final",
      payload: { text: "  " },
      suppression: { reason: "channel_transform" as const },
    },
  ])("does not capture a hidden final for $label", async ({ payload, suppression }) => {
    const cfg = createConfig();
    const interaction = createInteraction();
    interaction.responseState = "deferred";
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
      await plan.delivery.onDelivered?.(
        payload,
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression,
        },
      );
      return dispatchedTurn(plan, {
        counts: { final: 0, block: 0, tool: 0 },
        queuedFinal: false,
      });
    });

    const result = await dispatchAgentReply(cfg, interaction, true);

    expect(result.hiddenFinalReply).toBeUndefined();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("keeps a native reply visible when a later Discord chunk expires", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    interaction.followUp
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce({ discordCode: 10062, message: "Unknown interaction" });
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockImplementation(async (params: unknown) => {
      const dispatcherOptions = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
            onError?: (error: unknown, info: { kind: "final" }) => void;
          };
        }
      ).dispatcherOptions;
      try {
        await dispatcherOptions.deliver({ text: "x".repeat(2500) }, { kind: "final" });
      } catch (error) {
        dispatcherOptions.onError?.(error, { kind: "final" });
      }
      return {
        counts: { final: 0, block: 0, tool: 0 },
        failedCounts: { final: 1, block: 0, tool: 0 },
        queuedFinal: false,
      };
    });
    const command = await createNativeCommand(cfg);

    await command.run(interaction);

    expect(interaction.followUp).toHaveBeenCalledTimes(2);
    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "suppressed final replies before and after failure",
      kind: "final" as const,
      suppressAfterFailure: true,
    },
  ])("warns when a deferred final fails with $label", async ({ kind, suppressAfterFailure }) => {
    const cfg = createConfig();
    const interaction = createInteraction();
    interaction.followUp.mockRejectedValue({
      discordCode: 10062,
      message: "Unknown interaction",
    });
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
      const reportSuppressed = (suppressedKind: "block" | "final" | "tool") =>
        plan.delivery.onDelivered?.(
          { text: "cancelled intermediate reply" },
          { kind: suppressedKind },
          {
            visibleReplySent: false,
            suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
          },
        );
      if (kind) {
        await reportSuppressed(kind);
      }
      if (!("deliver" in plan.delivery)) {
        throw new Error("expected direct delivery adapter");
      }
      const deliver = plan.delivery.deliver;
      if (!deliver) {
        throw new Error("expected direct deliverer");
      }
      const payload = { text: "expired before delivery" };
      const info = { kind: "final" as const };
      let deliveryError: unknown;
      try {
        await deliver(payload, info);
      } catch (error) {
        deliveryError = error;
        plan.delivery.onError?.(error, info);
      }
      expect(deliveryError).toBeInstanceOf(PlatformMessageNotDispatchedError);
      if (suppressAfterFailure) {
        await reportSuppressed("final");
      }
      return dispatchedTurn(plan, {
        counts: { final: 0, block: 0, tool: 0 },
        failedCounts: { final: 1, block: 0, tool: 0 },
        queuedFinal: false,
      });
    });
    const command = await createNativeCommand(cfg);

    await command.run(interaction);

    expect(interaction.followUp).toHaveBeenCalledTimes(2);
    const fallback = requireRecord(
      (interaction.followUp as unknown as MockCalls).mock.calls[1]?.[0],
      "empty fallback",
    );
    expect(fallback.content).toBe("⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it.each([{ label: "a later failed final", outcomes: ["accepted", "failed"] as const }])(
    "keeps an accepted final visible alongside $label",
    async ({ outcomes }) => {
      const cfg = createConfig();
      const interaction = createInteraction();
      for (const outcome of outcomes) {
        if (outcome === "accepted") {
          interaction.followUp.mockResolvedValueOnce({ ok: true });
        } else if (outcome === "failed") {
          interaction.followUp.mockRejectedValueOnce(new Error("provider connection failed"));
        }
      }
      vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
        if (!("deliver" in plan.delivery) || !plan.delivery.deliver) {
          throw new Error("expected direct delivery adapter");
        }
        let failedFinals = 0;
        for (const outcome of outcomes) {
          const payload = { text: `${outcome} final` };
          const info = { kind: "final" as const };
          try {
            const result = await plan.delivery.deliver(payload, info);
            await plan.delivery.onDelivered?.(payload, info, result);
          } catch (error) {
            failedFinals += 1;
            plan.delivery.onError?.(error, info);
          }
        }
        return dispatchedTurn(plan, {
          counts: { final: 1, block: 0, tool: 0 },
          failedCounts: { final: failedFinals, block: 0, tool: 0 },
          queuedFinal: false,
        });
      });
      const command = await createNativeCommand(cfg);

      await command.run(interaction);

      expect(interaction.followUp).toHaveBeenCalledTimes(outcomes.length);
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: "accepted final" }),
      );
      expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.deleteReply).not.toHaveBeenCalled();
    },
  );

  it("preserves partial delivery when a later Discord chunk fails without expiry", async () => {
    const cfg = createConfig();
    const interaction = createInteraction();
    interaction.followUp
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("provider connection failed"));
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockImplementation(async (params: unknown) => {
      const dispatcherOptions = (
        params as {
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
            onError?: (error: unknown, info: { kind: "final" }) => void;
          };
        }
      ).dispatcherOptions;
      try {
        await dispatcherOptions.deliver({ text: "x".repeat(2500) }, { kind: "final" });
      } catch (error) {
        dispatcherOptions.onError?.(error, { kind: "final" });
      }
      return {
        counts: { final: 0, block: 0, tool: 0 },
        failedCounts: { final: 1, block: 0, tool: 0 },
        queuedFinal: false,
      };
    });
    const command = await createNativeCommand(cfg);

    await command.run(interaction);

    expect(interaction.followUp).toHaveBeenCalledTimes(2);
    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("returns an explicit warning when a direct plugin command has no visible reply", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction();
    runtimeModuleMocks.pluginCommandHandler.mockResolvedValue({});
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );
    const command = await createMockPluginNativeCommand(cfg, commandSpec);

    await command.run(interaction);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expectFollowUpFields(interaction, { content: "⚠️ Command produced no visible reply." });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("suppresses the warning when a direct plugin command suppresses replies", async () => {
    const cfg = createConfig();
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction();
    runtimeModuleMocks.pluginCommandHandler.mockResolvedValue({ suppressReply: true });
    const dispatchSpy = runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue(
      {} as never,
    );
    const command = await createMockPluginNativeCommand(cfg, commandSpec);

    await command.run(interaction);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("preserves fetched thread parent metadata when interaction parentId getter throws", async () => {
    const cfg = {
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: {
                "partial-thread-123": {
                  enabled: true,
                  requireMention: false,
                  users: ["user:owner"],
                },
                "partial-parent-456": {
                  enabled: true,
                  requireMention: false,
                  users: ["user:owner"],
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const commandSpec: NativeCommandSpec = {
      name: "cron_jobs",
      description: "List cron jobs",
      acceptsArgs: false,
    };
    const interaction = createInteraction({
      channelType: ChannelType.PublicThread,
      channelId: "partial-thread-123",
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    defineThrowingDiscordChannelGetter(interaction.channel, "parentId");
    (interaction.client as { fetchChannel: ReturnType<typeof vi.fn> }).fetchChannel = vi.fn(
      async (channelId: string) => {
        if (channelId === "partial-thread-123") {
          return {
            id: "partial-thread-123",
            type: ChannelType.PublicThread,
            parentId: "partial-parent-456",
          };
        }
        if (channelId === "partial-parent-456") {
          return { id: "partial-parent-456", type: ChannelType.GuildText, name: "Parent" };
        }
        return null;
      },
    );
    const executeSpy = runtimeModuleMocks.pluginCommandHandler.mockResolvedValue({
      text: "direct plugin output",
    });
    const command = await createMockPluginNativeCommand(cfg, commandSpec);

    await command.run(interaction);

    expectSingleCallFirstArg(executeSpy, {
      channel: "discord",
      from: "discord:channel:partial-thread-123",
      messageThreadId: "partial-thread-123",
      threadParentId: "partial-parent-456",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

installDiscordIngressTestRuntime();
