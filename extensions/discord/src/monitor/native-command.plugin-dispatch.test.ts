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
import { dispatchDiscordNativeAgentReply } from "./native-command-agent-reply.js";
import * as nativeCommandRoute from "./native-command-route.js";
import { nativeCommandContext } from "./native-command.dispatch.test-support.js";
import {
  createMockCommandInteraction as createInteraction,
  createRouteState,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";

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
const {
  pluginCommandHandler: pluginHandler,
  dispatchReplyWithDispatcher: dispatchReply,
  resolveDirectStatusReplyForSession: statusReply,
  getSessionEntry: sessionEntry,
  recordDeliveredCommandExchange: recordExchange,
} = runtimeModuleMocks;
let observedNativeTurnDispatcher: unknown;

const dispatchChannelInboundTurnForTest: typeof channelInbound.dispatchChannelInboundTurn = async (
  plan,
) => {
  observedNativeTurnDispatcher = plan.dispatchReplyFromConfig;
  const dispatchResult = await dispatchReply({
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

const emptyDispatchResult = { counts: { final: 0, block: 0, tool: 0 }, queuedFinal: false };

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
    pluginCommandDispatch: { kind: "non-plugin" },
    suppressReplies,
    log: { error: vi.fn() } as never,
  });
}

function createConfig(): OpenClawConfig {
  return {
    channels: { discord: { dm: { enabled: true }, dmPolicy: "open", allowFrom: ["*"] } },
  };
}

const guildId = "345678901234567890";
const channelId = "234567890123456789";
function guildConfig(commands: OpenClawConfig["commands"]): OpenClawConfig {
  return {
    commands,
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          [guildId]: { channels: { [channelId]: { enabled: true, requireMention: false } } },
        },
      },
    },
  };
}

function guildInteraction() {
  const interaction = createInteraction({
    channelType: ChannelType.GuildText,
    channelId,
    guildId,
    guildName: "Test Guild",
    userId: "999999999999999999",
  });
  interaction.options.getString.mockReturnValue("now");
  return interaction;
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
    ...nativeCommandContext(cfg),
    ephemeralDefault: true,
    dispatchReplyFromConfig,
  });
}

const cronCommand: NativeCommandSpec = {
  name: "cron_jobs",
  description: "List cron jobs",
  acceptsArgs: false,
};

type MockCalls = {
  mock: { calls: unknown[][] };
};

function expectSingleCallFirstArg(mock: MockCalls, expected: Record<string, unknown>): void {
  expect(mock.mock.calls).toHaveLength(1);
  expect(mock.mock.calls[0]?.[0]).toEqual(expect.objectContaining(expected));
}

function expectNoFollowUpContent(interaction: MockCommandInteraction, content: string) {
  expect(interaction.followUp).not.toHaveBeenCalledWith(expect.objectContaining({ content }));
}

function expectSilentSettlement(interaction: MockCommandInteraction) {
  expect(interaction.followUp).not.toHaveBeenCalled();
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
}

function expectEmptyWarning(interaction: MockCommandInteraction) {
  expectSingleCallFirstArg(interaction.followUp, {
    content: "⚠️ Command produced no visible reply.",
    ephemeral: true,
  });
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.deleteReply).not.toHaveBeenCalled();
}

async function createPluginCommand(params: { cfg: OpenClawConfig; name: string }) {
  const registration = getActivePluginRegistry()?.commands.find(
    (entry) =>
      entry.command.name === params.name || entry.command.nativeNames?.discord === params.name,
  );
  if (!registration) {
    throw new Error(`expected plugin command registration ${params.name}`);
  }
  const originalHandler = registration.command.handler;
  registration.command.handler = async (ctx) =>
    await pluginHandler({
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
    ...nativeCommandContext(params.cfg),
    ephemeralDefault: true,
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

function registerPairPlugin(
  requiredScopes?: Parameters<typeof registerPluginCommand>[1]["requiredScopes"],
) {
  const handler = vi.fn(async ({ args }: { args?: string }) => ({ text: `paired:${args ?? ""}` }));
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      ...(requiredScopes ? { requiredScopes } : {}),
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

describe("Discord native plugin command dispatch", () => {
  let cfg: OpenClawConfig;
  let interaction: MockCommandInteraction;
  async function runNativeCommand(spec?: NativeCommandSpec) {
    await (await createNativeCommand(cfg, spec)).run(interaction);
  }
  beforeAll(async () => {
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
  });

  afterAll(() => {
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
  });

  beforeEach(() => {
    cfg = createConfig();
    interaction = createInteraction();
    observedNativeTurnDispatcher = undefined;
    clearRuntimeConfigSnapshot();
    vi.clearAllMocks();
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
    pluginHandler.mockReset();
    pluginHandler.mockImplementation(
      async (params: { run?: () => Promise<unknown> }) => await params.run?.(),
    );
    dispatchReply.mockReset().mockResolvedValue({ counts: { final: 1, block: 0, tool: 0 } });
    statusReply.mockReset().mockResolvedValue({ text: "status reply" });
    sessionEntry.mockReset().mockReturnValue(undefined);
    recordExchange.mockClear();
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(
      dispatchChannelInboundTurnForTest,
    );
    vi.spyOn(commandStatus, "resolveDirectStatusReplyForSession").mockImplementation(statusReply);
    vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
      (params) =>
        createRouteState({
          sessionKey: params.channelContext.isDirectMessage
            ? `agent:main:discord:dm:${params.interaction.user?.id ?? "owner"}`
            : `agent:main:discord:channel:${params.conversationId ?? params.channelContext.rawChannelId}`,
          accountId: params.accountId,
        }),
    );
    vi.spyOn(sessionStore, "getSessionEntryAsync").mockImplementation(async (params) =>
      sessionEntry(params),
    );
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("keeps the owning Gateway dispatcher on a native slash turn", async () => {
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

    await command.run(createInteraction());
    setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
    await command.run(createInteraction());

    expect(statusReply).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
    expect(statusReply).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionKey: "agent:main:discord:direct:owner" }),
    );
  });

  it("carries the built-in catalog winner through the interaction", async () => {
    const shadowHandler = vi.fn(async () => ({ text: "wrong plugin" }));
    getActivePluginRegistry()!.commands.push({
      pluginId: "shadow-plugin",
      source: "test",
      command: {
        name: "help",
        description: "Shadow help",
        channels: ["discord"],
        requireAuth: false,
        handler: shadowHandler,
      },
    });
    const help: NativeCommandSpec = {
      name: "help",
      description: "Show help",
      acceptsArgs: false,
    };
    const command = await createNativeCommand(cfg, help);

    await command.run(createInteraction());

    expect(shadowHandler).not.toHaveBeenCalled();
    expect(dispatchReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
        }),
      }),
    );
  });

  it("passes the configured binding agent to plugin-owned Discord command sessions", async () => {
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
    sessionEntry.mockReturnValue({
      sessionId: "codex-session",
      authProfileOverride: "openai:owner@example.com",
      updatedAt: Date.now(),
    });

    registerPairPlugin();
    const command = await createPluginCommand({ cfg, name: "pair" });
    const executeSpy = pluginHandler.mockResolvedValue({
      text: "paired:now",
    });

    interaction.options.getString.mockReturnValue("now");
    await command.run(interaction);

    expectSingleCallFirstArg(executeSpy, {
      command: expect.objectContaining({ name: "pair" }),
      agentId: "codex",
      sessionKey: pluginSessionKey,
    });
    expect(sessionEntry).toHaveBeenCalledWith({
      agentId: "codex",
      sessionKey: pluginSessionKey,
    });
    expect(recordExchange).toHaveBeenCalledWith(
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
      cfg.channels!.discord!.allowFrom = allowFrom;
      interaction = createInteraction({ userId });
      interaction.options.getString.mockReturnValue("now");
      const handler = registerPairPlugin(["operator.pairing"]);
      const command = await createPluginCommand({ cfg, name: "pair" });

      await command.run(interaction);

      expect(handler).not.toHaveBeenCalled();
      expectSingleCallFirstArg(interaction.followUp, {
        content: "⚠️ This command requires gateway scope: operator.pairing.",
      });
      expect(interaction.reply).not.toHaveBeenCalled();
    },
  );

  it("allows generic command owners to run scoped Discord plugin commands without gateway scopes", async () => {
    cfg = { ...createConfig(), commands: { ownerAllowFrom: ["discord:123456789012345678"] } };
    interaction = createInteraction({ userId: "123456789012345678" });
    interaction.options.getString.mockReturnValue("now");
    const handler = registerPairPlugin(["operator.pairing"]);
    const command = await createPluginCommand({ cfg, name: "pair" });

    await command.run(interaction);

    expect(handler).toHaveBeenCalledTimes(1);
    expectSingleCallFirstArg(interaction.followUp, { content: "paired:now" });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("blocks unauthorized Discord senders before requireAuth:false plugin commands execute", async () => {
    cfg = guildConfig({ allowFrom: { discord: ["user:123456789012345678"] } });
    interaction = guildInteraction();
    registerPairPlugin();
    const command = await createPluginCommand({ cfg, name: "pair" });

    const executeSpy = pluginHandler;
    const dispatchSpy = dispatchReply.mockResolvedValue({} as never);

    await command.run(interaction);

    expect(executeSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expectSingleCallFirstArg(interaction.followUp, {
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
      cfg = guildConfig({ ownerAllowFrom: [ownerAllowFrom] });
      interaction = guildInteraction();
      registerPairPlugin();
      const executeSpy = pluginHandler.mockResolvedValue({
        text: "open:now",
      });
      const command = await createPluginCommand({ cfg, name: "pair" });

      await command.run(interaction);

      expectSingleCallFirstArg(executeSpy, {
        command: expect.objectContaining({ name: "pair" }),
        args: "now",
      });
      expectSingleCallFirstArg(interaction.followUp, { content: "open:now" });
      expect(interaction.reply).not.toHaveBeenCalled();
    });
  }

  it("rejects group DM slash commands outside dm.groupChannels before dispatch", async () => {
    cfg = {
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
    interaction = createInteraction({
      channelType: ChannelType.GroupDM,
      channelId: "blocked-group",
    });
    const dispatchSpy = dispatchReply;
    const command = await createStatusCommand(cfg);

    await command.run(interaction);

    expect(dispatchSpy).not.toHaveBeenCalled();
    expectSingleCallFirstArg(interaction.followUp, {
      content: "This group DM is not allowed.",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("settles an accepted active-run steer without an empty warning", async () => {
    dispatchReply.mockResolvedValue({
      ...emptyDispatchResult,
      deferredToActiveRun: "steer",
    } as never);
    await runNativeCommand({
      name: "steer",
      description: "Steer an active run.",
      acceptsArgs: true,
    });

    expectSilentSettlement(interaction);
  });

  it("warns when the inbound turn is dropped before dispatch", async () => {
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async () => ({
      admission: { kind: "drop", reason: "ingest-null" },
      dispatched: false,
    }));

    const result = await dispatchAgentReply(cfg, interaction);

    expect(result).toEqual({ dispatched: false });
    expectEmptyWarning(interaction);
  });

  it("settles deliberate command silence without an empty warning", async () => {
    dispatchReply.mockResolvedValue({
      ...emptyDispatchResult,
      deliberateSilentTerminalReply: true,
    } as never);
    await runNativeCommand();

    expectSilentSettlement(interaction);
  });

  it("warns when a final delivery observer does not report its outcome", async () => {
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(async (plan) => {
      await plan.delivery.onDelivered?.({ text: "unreported" }, { kind: "final" }, undefined);
      return dispatchedTurn(plan, emptyDispatchResult);
    });
    await runNativeCommand();

    expectEmptyWarning(interaction);
  });

  it("settles repeated suppressed finals without an empty warning", async () => {
    const count = 2;
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
      return dispatchedTurn(plan, emptyDispatchResult);
    });
    await runNativeCommand();

    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("preserves a hidden error final and its metadata", async () => {
    const isError = true;
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
      return dispatchedTurn(plan, emptyDispatchResult);
    });

    const result = await dispatchAgentReply(cfg, interaction, true);

    expect(result.hiddenFinalReply).toBe(finalReply);
    expect(result.hiddenFinalReply?.isError).toBe(isError);
    expectSilentSettlement(interaction);
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
      return dispatchedTurn(plan, emptyDispatchResult);
    });

    const result = await dispatchAgentReply(cfg, interaction, true);

    expect(result.hiddenFinalReply).toBeUndefined();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("keeps a native reply visible when a later Discord chunk expires", async () => {
    interaction.followUp
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce({ discordCode: 10062, message: "Unknown interaction" });
    dispatchReply.mockImplementation(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
          onError?: (error: unknown, info: { kind: "final" }) => void;
        };
      }) => {
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
      },
    );
    await runNativeCommand();

    expect(interaction.followUp).toHaveBeenCalledTimes(2);
    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it("warns when a deferred final fails with suppressed finals before and after failure", async () => {
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
      await reportSuppressed("final");
      if (!("deliver" in plan.delivery) || !plan.delivery.deliver) {
        throw new Error("expected direct deliverer");
      }
      const deliver = plan.delivery.deliver;
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
      await reportSuppressed("final");
      return dispatchedTurn(plan, {
        counts: { final: 0, block: 0, tool: 0 },
        failedCounts: { final: 1, block: 0, tool: 0 },
        queuedFinal: false,
      });
    });
    await runNativeCommand();

    expect(interaction.followUp).toHaveBeenCalledTimes(2);
    expect(interaction.followUp.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ content: "⚠️ Command produced no visible reply." }),
    );
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it("keeps an accepted final visible alongside a later failed final", async () => {
    const outcomes = ["accepted", "failed"] as const;
    interaction.followUp
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("provider connection failed"));
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
    await runNativeCommand();

    expect(interaction.followUp).toHaveBeenCalledTimes(outcomes.length);
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "accepted final" }),
    );
    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "handles an empty direct plugin reply (suppressed=%s)",
    async (suppress) => {
      pluginHandler.mockResolvedValue(suppress ? { suppressReply: true } : {});
      const dispatchSpy = dispatchReply.mockResolvedValue({} as never);
      const command = await createMockPluginNativeCommand(cfg, cronCommand);
      await command.run(interaction);
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
      if (suppress) {
        expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
      } else {
        expectSingleCallFirstArg(interaction.followUp, {
          content: "⚠️ Command produced no visible reply.",
        });
      }
    },
  );

  it("preserves fetched thread parent metadata when interaction omits parentId", async () => {
    const allowedChannel = { enabled: true, requireMention: false, users: ["user:owner"] };
    cfg = guildConfig(undefined);
    cfg.channels!.discord!.guilds![guildId]!.channels = {
      "partial-thread-123": allowedChannel,
      "partial-parent-456": allowedChannel,
    };
    interaction = createInteraction({
      channelType: ChannelType.PublicThread,
      channelId: "partial-thread-123",
      guildId: "345678901234567890",
      guildName: "Test Guild",
    });
    (interaction.client as { fetchChannel: ReturnType<typeof vi.fn> }).fetchChannel = vi.fn(
      async (requestedChannelId: string) => {
        if (requestedChannelId === "partial-thread-123") {
          return {
            id: "partial-thread-123",
            type: ChannelType.PublicThread,
            parentId: "partial-parent-456",
          };
        }
        if (requestedChannelId === "partial-parent-456") {
          return { id: "partial-parent-456", type: ChannelType.GuildText, name: "Parent" };
        }
        return null;
      },
    );
    const executeSpy = pluginHandler.mockResolvedValue({
      text: "direct plugin output",
    });
    const command = await createMockPluginNativeCommand(cfg, cronCommand);

    await command.run(interaction);

    expectSingleCallFirstArg(executeSpy, {
      channel: "discord",
      from: "discord:channel:partial-thread-123",
      messageThreadId: "partial-thread-123",
      threadParentId: "partial-parent-456",
    });
  });
});
installDiscordIngressTestRuntime();
