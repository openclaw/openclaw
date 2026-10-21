import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import * as commandStatus from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
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
import type { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
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
import {
  forwardNativeCommand,
  nativeCommandContext,
} from "./native-command.dispatch.test-support.js";
import {
  createMockCommandInteraction as createInteraction,
  createRouteState,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import {
  channelId,
  guildId,
  createConfig,
  guildConfig,
  guildInteraction,
  statusCommand,
  cronCommand,
  directDelivery,
  dispatchedTurn,
  emptyDispatchResult,
  interceptDelivery,
  expectSingleCallFirstArg,
  expectNoFollowUpContent,
  expectSilentSettlement,
  expectEmptyWarning,
} from "./native-command.test-support.js";

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
const runtimeModuleMocks = vi.hoisted(() => ({
  pluginCommandHandler: vi.fn(),
  dispatchReplyWithDispatcher: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
  getSessionEntry: vi.fn(),
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
  loadWebMedia: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: runtimeModuleMocks.recordDeliveredCommandExchange,
}));
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: runtimeModuleMocks.loadWebMedia,
}));
const {
  pluginCommandHandler: pluginHandler,
  dispatchReplyWithDispatcher: dispatchReply,
  resolveDirectStatusReplyForSession: statusReply,
  getSessionEntry: sessionEntry,
  recordDeliveredCommandExchange: recordExchange,
} = runtimeModuleMocks;
const dispatchChannelInboundTurnForTest: typeof channelInbound.dispatchChannelInboundTurn = async (
  plan,
) => {
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

async function createNativeCommand(
  cfg: OpenClawConfig,
  commandSpec: NativeCommandSpec = {
    name: "new",
    description: "Start a new session.",
    acceptsArgs: true,
  },
) {
  return createDiscordNativeCommand({
    command: commandSpec,
    ...nativeCommandContext(cfg),
    ephemeralDefault: true,
  });
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

function registerPairPlugin() {
  const handler = vi.fn(async ({ args }: { args?: string }) => ({ text: `paired:${args ?? ""}` }));
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      handler,
    }),
  ).toEqual({ ok: true });
  return handler;
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
    const command = await createNativeCommand(sourceCfg, statusCommand);

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

  it("blocks unauthorized Discord senders before requireAuth:false plugin commands execute", async () => {
    cfg = guildConfig({ allowFrom: { discord: ["user:123456789012345678"] } });
    interaction = guildInteraction();
    registerPairPlugin();
    const command = await createPluginCommand({ cfg, name: "pair" });
    dispatchReply.mockResolvedValue({} as never);
    await command.run(interaction);
    expect(pluginHandler).not.toHaveBeenCalled();
    expect(dispatchReply).not.toHaveBeenCalled();
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
    cfg.commands = { allowFrom: { discord: ["user:owner"] } };
    cfg.channels!.discord!.dm = {
      enabled: true,
      groupEnabled: true,
      groupChannels: ["allowed-group"],
    };
    delete cfg.channels!.discord!.allowFrom;
    interaction = createInteraction({
      channelType: ChannelType.GroupDM,
      channelId: "blocked-group",
    });
    await (await createNativeCommand(cfg, statusCommand)).run(interaction);
    expect(dispatchReply).not.toHaveBeenCalled();
    expectSingleCallFirstArg(interaction.followUp, {
      content: "This group DM is not allowed.",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it.each([
    { label: "active-run steer", name: "steer", result: { deferredToActiveRun: "steer" } },
    {
      label: "deliberate command silence",
      name: "new",
      result: { deliberateSilentTerminalReply: true },
    },
  ])("settles $label without an empty warning", async ({ name, result }) => {
    dispatchReply.mockResolvedValue({ ...emptyDispatchResult, ...result });
    await runNativeCommand({ name, description: name, acceptsArgs: true });
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

  it("warns when a final delivery observer does not report its outcome", async () => {
    interceptDelivery(async (plan) => {
      await plan.delivery.onDelivered?.({ text: "unreported" }, { kind: "final" }, undefined);
    });
    await runNativeCommand();

    expectEmptyWarning(interaction);
  });

  it("settles repeated suppressed finals without an empty warning", async () => {
    interceptDelivery(async (plan) => {
      for (let index = 0; index < 2; index += 1) {
        await plan.delivery.onDelivered?.(
          { text: "cancelled" },
          { kind: "final" },
          {
            visibleReplySent: false,
            suppression: { reason: "cancelled_by_reply_payload_sending_hook" },
          },
        );
      }
    });
    await runNativeCommand();

    expectNoFollowUpContent(interaction, "⚠️ Command produced no visible reply.");
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("preserves a hidden error final and its metadata", async () => {
    interaction.responseState = "deferred";
    const finalReply = setReplyPayloadMetadata(
      { text: "scope-aware model selection result", isError: true },
      { assistantMessageIndex: 3 },
    );
    interceptDelivery(async (plan) => {
      const info = { kind: "final" as const };
      const deliveryResult = await directDelivery(plan)(finalReply, info);
      expect(deliveryResult).toEqual({
        visibleReplySent: false,
        suppression: { reason: "channel_transform" },
      });
      await plan.delivery.onDelivered?.(finalReply, info, deliveryResult);
    });

    const result = await dispatchAgentReply(cfg, interaction, true);

    expect(result.hiddenFinalReply).toBe(finalReply);
    expect(result.hiddenFinalReply?.isError).toBe(true);
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
    interceptDelivery(async (plan) => {
      await plan.delivery.onDelivered?.(
        payload,
        { kind: "final" },
        {
          visibleReplySent: false,
          suppression,
        },
      );
    });

    const result = await dispatchAgentReply(cfg, interaction, true);

    expect(result.hiddenFinalReply).toBeUndefined();
    expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
  });

  it("keeps a native reply visible when a later Discord chunk expires", async () => {
    interaction.followUp
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce({ discordCode: 10062, message: "Unknown interaction" });
    interceptDelivery(async (plan) => {
      try {
        await directDelivery(plan)({ text: "x".repeat(2500) }, { kind: "final" });
      } catch (error) {
        plan.delivery.onError?.(error, { kind: "final" });
      }
      return { ...emptyDispatchResult, failedCounts: { final: 1, block: 0, tool: 0 } };
    });
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
    interceptDelivery(async (plan) => {
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
      const deliver = directDelivery(plan);
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
      return {
        counts: { final: 0, block: 0, tool: 0 },
        failedCounts: { final: 1, block: 0, tool: 0 },
        queuedFinal: false,
      };
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
    interceptDelivery(async (plan) => {
      const deliver = directDelivery(plan);
      let failedFinals = 0;
      for (const outcome of outcomes) {
        const payload = { text: `${outcome} final` };
        const info = { kind: "final" as const };
        try {
          const result = await deliver(payload, info);
          await plan.delivery.onDelivered?.(payload, info, result);
        } catch (error) {
          failedFinals += 1;
          plan.delivery.onError?.(error, info);
        }
      }
      return {
        counts: { final: 1, block: 0, tool: 0 },
        failedCounts: { final: failedFinals, block: 0, tool: 0 },
        queuedFinal: false,
      };
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

  describe("guild command authorization and arguments", () => {
    const OWNER = "123456789012345678";
    const OTHER = "999999999999999999";
    const ownerUser = `user:${OWNER}`;
    const ownerCommand = `discord:${OWNER}`;

    beforeEach(() => {
      vi.mocked(nativeCommandRoute.resolveDiscordNativeInteractionRouteState).mockRestore();
      vi.mocked(sessionStore.getSessionEntryAsync).mockRestore();
      vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(
        forwardNativeCommand(dispatchReply, true),
      );
      cfg = guildConfig({ allowFrom: { discord: [ownerUser] } });
      interaction = createInteraction({
        userId: OWNER,
        username: "discord-user",
        globalName: "Discord User",
        channelType: ChannelType.GuildText,
        channelId,
        guildId,
        guildName: "Test Guild",
      });
    });

    type GuildRun = {
      userId?: string;
      channelUsers?: string[];
      commands?: OpenClawConfig["commands"];
      discord?: Partial<DiscordAccountConfig>;
      runtimeDiscordConfig?: DiscordAccountConfig;
      commandSpec?: NativeCommandSpec;
      optionValues?: Record<string, string>;
    };
    async function runGuild(params: GuildRun = {}) {
      if (params.commands) {
        cfg.commands = params.commands;
      }
      if (params.channelUsers) {
        cfg.channels!.discord!.guilds![guildId]!.channels![channelId]!.users = params.channelUsers;
      }
      Object.assign(cfg.channels!.discord!, params.discord);
      if (params.userId) {
        interaction.user.id = params.userId;
      }
      interaction.options.getString.mockImplementation(
        (name: string) => params.optionValues?.[name] ?? null,
      );
      return createDiscordNativeCommand({
        command: params.commandSpec ?? { name: "ping", description: "Ping", acceptsArgs: false },
        ...nativeCommandContext(cfg, params.runtimeDiscordConfig),
        ephemeralDefault: true,
      }).run(interaction);
    }
    function firstDispatch() {
      const call = dispatchReply.mock.calls[0];
      if (!call) {
        throw new Error("expected dispatchReplyWithDispatcher call");
      }
      return call[0] as Parameters<typeof dispatchReplyWithDispatcher>[0];
    }
    async function expectAccess(params: GuildRun, allowed: boolean) {
      await runGuild(params);
      expect(dispatchReply).toHaveBeenCalledTimes(allowed ? 1 : 0);
      const content = "You are not authorized to use this command.";
      if (allowed) {
        expect(firstDispatch()).toEqual(
          expect.objectContaining({
            replyOptions: expect.objectContaining({
              [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
            }),
          }),
        );
        expect(interaction.followUp).not.toHaveBeenCalledWith(expect.objectContaining({ content }));
      } else {
        expect(interaction.followUp).toHaveBeenCalledWith({ content, ephemeral: true });
        expect(interaction.reply).not.toHaveBeenCalled();
      }
    }

    it.each([false, true])(
      "requires opt-in for explicit owner name matching: %s",
      async (enabled) => {
        await expectAccess(
          {
            commands: { ownerAllowFrom: ["discord:discord-user"] },
            discord: { dangerouslyAllowNameMatching: enabled },
          },
          enabled,
        );
      },
    );

    it.each<[string, boolean, GuildRun]>([
      [
        "command allowlist overrides owner",
        true,
        {
          userId: OTHER,
          commands: { ownerAllowFrom: [ownerCommand], allowFrom: { discord: [`user:${OTHER}`] } },
        },
      ],
      ["global command allowlist", true, { commands: { allowFrom: { "*": [ownerUser] } } }],
      ["channel includes member", true, { channelUsers: [ownerUser], commands: {} }],
      [
        "channel excludes member",
        false,
        { userId: OTHER, channelUsers: [ownerUser], commands: {} },
      ],
      [
        "Discord owner restriction",
        false,
        {
          userId: OTHER,
          commands: {},
          discord: { allowFrom: [ownerUser] },
        },
      ],
      [
        "command owner rejects despite channel gate",
        false,
        { userId: OTHER, commands: { ownerAllowFrom: [ownerCommand] } },
      ],
      [
        "matching guild allowlist",
        true,
        { userId: OTHER, commands: { allowFrom: { discord: [`guild:${guildId}`] } } },
      ],
      [
        "nonmatching guild allowlist",
        false,
        { userId: OTHER, commands: { allowFrom: { discord: ["guild:000000000000000000"] } } },
      ],
    ])("enforces %s", async (_name, allowed, params) => {
      await expectAccess(params, allowed);
    });

    it("uses the root discord maxLinesPerMessage when runtime discordConfig omits it", async () => {
      const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join(
        "\n",
      );
      await runGuild({
        discord: { maxLinesPerMessage: 120 },
        runtimeDiscordConfig: guildConfig({ allowFrom: { discord: [ownerUser] } }).channels!
          .discord,
      });
      await firstDispatch().dispatcherOptions.deliver({ text: longReply }, { kind: "final" });
      expect(interaction.followUp).toHaveBeenCalledWith({ content: longReply, ephemeral: true });
      expect(interaction.reply).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, string>, string]>([
      [
        "config",
        { action: " GET ", path: " agents.defaults.model " },
        "/config get agents.defaults.model",
      ],
      ["debug", { action: "unset" }, "/debug unset"],
    ])(
      "serializes structured /%s args and delivers the visible reply",
      async (command, optionValues, expectedPrompt) => {
        const visibleReply = `Handled ${expectedPrompt}`;
        await runGuild({
          commandSpec: { name: command, description: `Test ${command}`, acceptsArgs: true },
          optionValues,
        });
        const call = firstDispatch();
        expect(call.ctx.Body).toBe(expectedPrompt);
        expect(call.ctx.CommandArgs?.raw).toBe(expectedPrompt.slice(command.length + 2));
        await call.dispatcherOptions.deliver({ text: visibleReply }, { kind: "final" });
        expect(interaction.followUp).toHaveBeenCalledWith({
          content: visibleReply,
          ephemeral: true,
        });
        expect(interaction.reply).not.toHaveBeenCalled();
      },
    );

    it("swallows expired slash interactions before dispatch when defer returns Unknown interaction", async () => {
      interaction.defer.mockRejectedValue({
        status: 404,
        discordCode: 10062,
        rawBody: { message: "Unknown interaction", code: 10062 },
      });
      const result = await runGuild();
      expect(result).toBeUndefined();
      expect(interaction.defer).toHaveBeenCalledTimes(1);
      expect(dispatchReply).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.followUp).not.toHaveBeenCalled();
    });
  });

  describe("direct status replies", () => {
    const { loadWebMedia } = runtimeModuleMocks;
    beforeEach(() => {
      cfg.commands = { allowFrom: { discord: ["user:owner"] } };
      cfg.channels!.discord!.groupPolicy = "open";
      cfg.channels!.discord!.guilds = {
        guild1: {
          requireMention: true,
          channels: { chan1: { enabled: true, requireMention: true } },
        },
      };
      vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
        ({ accountId }) => createRouteState({ sessionKey: "agent:main:main", accountId }),
      );
      loadWebMedia.mockResolvedValue({ buffer: Buffer.from("image"), fileName: "status.png" });
    });

    async function runStatus(pluginExecute?: ReturnType<typeof vi.fn>) {
      const command = await createNativeCommand(cfg, {
        name: "status",
        description: "Status",
        acceptsArgs: false,
        ...(pluginExecute
          ? {
              requireAuth: true,
              prepareDispatch: () => ({
                kind: "plugin" as const,
                invocation: { runtime: { execute: pluginExecute }, selection: Object.freeze({}) },
              }),
            }
          : {}),
      } as never);
      await command.run(interaction);
    }

    it("delivers an embed-only direct status reply without reporting it unavailable", async () => {
      const embeds = [{ title: "Status", description: "All systems operational" }];
      statusReply.mockResolvedValue({ channelData: { discord: { embeds } } });
      await runStatus();
      expect(dispatchReply).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledOnce();
      expect(interaction.followUp.mock.calls[0]?.[0]).toStrictEqual({ embeds, ephemeral: true });
    });

    it("prioritizes direct status replies over matching plugin commands", async () => {
      const executePluginCommand = vi.fn(async () => ({ text: "plugin status" }));
      await runStatus(executePluginCommand);
      expect(statusReply).toHaveBeenCalledTimes(1);
      expect(executePluginCommand).not.toHaveBeenCalled();
      expect(dispatchReply).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledOnce();
      expect(interaction.followUp.mock.calls[0]?.[0]).toStrictEqual({
        content: "status reply",
        ephemeral: true,
      });
      expect(recordExchange).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          commandText: "/status",
          replyText: "status reply",
          commandId: expect.stringMatching(/^discord:default:/),
        }),
      );
    });

    it.each([false, true])(
      "records the unavailable status only after delivery (failed=%s)",
      async (failed) => {
        statusReply.mockResolvedValue(undefined);
        if (failed) {
          interaction.followUp.mockRejectedValueOnce({ discordCode: 10062 });
        }
        await runStatus();
        expect(recordExchange).toHaveBeenCalledTimes(failed ? 0 : 1);
        if (!failed) {
          expect(recordExchange).toHaveBeenCalledWith(
            expect.objectContaining({
              commandText: "/status",
              replyText: "Status unavailable.",
            }),
          );
        }
      },
    );

    it("keeps direct status media follow-up chunks ephemeral", async () => {
      statusReply.mockResolvedValue({
        text: `status image\n${"x".repeat(2200)}`,
        mediaUrls: ["https://example.com/status.png"],
      });
      await runStatus();
      expect(loadWebMedia).toHaveBeenCalledExactlyOnceWith("https://example.com/status.png", {
        localRoots: expect.any(Array),
      });
      expect(interaction.followUp.mock.calls.length).toBeGreaterThan(1);
      expect(interaction.followUp.mock.calls[0]?.[0]).toMatchObject({
        ephemeral: true,
        files: [{ name: "status.png" }],
      });
      for (const [payload] of interaction.followUp.mock.calls) {
        expect(payload.ephemeral).toBe(true);
      }
      expect(interaction.reply).not.toHaveBeenCalled();
    });

    it("passes through the effective guild activation when requireMention is disabled", async () => {
      cfg.channels!.discord!.guilds!.guild1!.channels!.chan1!.requireMention = false;
      interaction = createInteraction({
        channelType: ChannelType.GuildText,
        channelId: "chan1",
        guildId: "guild1",
        guildName: "Guild One",
      });
      await runStatus();
      const statusCall = statusReply.mock.calls[0]?.[0] as Parameters<
        typeof commandStatus.resolveDirectStatusReplyForSession
      >[0];
      expect(statusCall).toMatchObject({ channel: "discord", isGroup: true });
      expect(statusCall.defaultGroupActivation?.()).toBe("always");
    });
  });
});
installDiscordIngressTestRuntime();
