// Discord tests cover native model-picker authorization boundaries.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth-native";
import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as runtimeConfigSnapshotModule from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  listSessionEntries,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as modelPickerModule from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import { authorizeDiscordModelPickerInteraction } from "./native-command-model-picker-authorization.js";
import { resolveDiscordModelPickerRoute } from "./native-command-model-picker-ui.js";
import { nativeCommandRuntime } from "./native-command.runtime.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

const MODEL_COMMAND: ChatCommandDefinition = {
  key: "model",
  nativeName: "model",
  description: "Switch model",
  textAliases: ["/model"],
  acceptsArgs: true,
  argsParsing: "none",
  scope: "native",
};
const THINK_COMMAND: ChatCommandDefinition = {
  key: "think",
  nativeName: "think",
  description: "Set thinking level",
  textAliases: ["/think"],
  acceptsArgs: true,
  args: [
    {
      name: "level",
      description: "Thinking level",
      type: "string",
      choices: ["off", "high"],
    },
  ],
  argsMenu: "auto",
  scope: "native",
};

type NativeCommandModule = typeof import("./native-command.js");
type PickerButton = ReturnType<NativeCommandModule["createDiscordModelPickerFallbackButton"]>;
type PickerInteraction = Parameters<PickerButton["run"]>[0];
type PickerData = Parameters<PickerButton["run"]>[1];

let createDiscordNativeCommand: NativeCommandModule["createDiscordNativeCommand"];
let createDiscordModelPickerFallbackButton: NativeCommandModule["createDiscordModelPickerFallbackButton"];
let tempDir: string;
const originalMatchPluginCommand = nativeCommandRuntime.matchPluginCommand;

function createConfig(): OpenClawConfig {
  return {
    commands: { useAccessGroups: false },
    session: { store: path.join(tempDir, "sessions.json") },
    channels: {
      discord: {
        groupPolicy: "open",
        guilds: {
          guild1: {
            channels: {
              chan1: { allow: true },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function installOutsiderDenialPolicy() {
  const handler = vi.fn(() => ({ effect: "deny" as const, code: "outsider-denied" }));
  const registry = createEmptyPluginRegistry();
  registry.authorizationPolicies.push({
    pluginId: "sender-access",
    source: "test",
    policy: {
      id: "maintainer-actions",
      description: "Deny outsider native commands",
      handlers: { "command.invoke": handler },
    },
  });
  setActivePluginRegistry(registry);
  return handler;
}

function createPickerInteraction() {
  const interaction = {
    user: { id: "outsider", username: "outsider", globalName: "Outsider" },
    channel: { type: ChannelType.GuildText, id: "chan1" },
    guild: { id: "guild1", name: "Guild" },
    rawData: { id: "picker-interaction", member: { roles: ["clawtributor"] } },
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    editReply: vi.fn().mockResolvedValue({ ok: true }),
    acknowledge: vi.fn(),
    acknowledged: false,
    client: {},
  };
  interaction.acknowledge.mockImplementation(async () => {
    interaction.acknowledged = true;
    return { ok: true };
  });
  return interaction;
}

function createRebindableThreadBindingManager(params: {
  threadId: string;
  initial: { agentId: string; sessionKey: string };
}): {
  manager: ThreadBindingManager;
  rebind: (target: { agentId: string; sessionKey: string }) => void;
} {
  const base = createNoopThreadBindingManager("default");
  let target = params.initial;
  const now = Date.now();
  return {
    manager: {
      ...base,
      getByThreadId: (threadId) =>
        threadId === params.threadId
          ? {
              accountId: "default",
              channelId: "chan1",
              threadId,
              targetKind: "subagent",
              targetSessionKey: target.sessionKey,
              agentId: target.agentId,
              boundBy: "system",
              boundAt: now,
              lastActivityAt: now,
              idleTimeoutMs: 24 * 60 * 60 * 1000,
              maxAgeMs: 0,
            }
          : base.getByThreadId(threadId),
    },
    rebind: (nextTarget) => {
      target = nextTarget;
    },
  };
}

describe("Discord native model picker authorization", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand, createDiscordModelPickerFallbackButton } =
      await import("./native-command.js"));
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-discord-picker-auth-"));
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(null);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(null);
    vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) => {
      if (name === "model") {
        return MODEL_COMMAND;
      }
      return name === "think" ? THINK_COMMAND : undefined;
    });
    vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([
      MODEL_COMMAND,
      THINK_COMMAND,
    ]);
    nativeCommandRuntime.matchPluginCommand = (() =>
      null) as typeof nativeCommandRuntime.matchPluginCommand;
  });

  afterEach(async () => {
    nativeCommandRuntime.matchPluginCommand = originalMatchPluginCommand;
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("blocks a guild outsider before opening the native picker", async () => {
    const authorizationHandler = installOutsiderDenialPolicy();
    const cfg = createConfig();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const command = createDiscordNativeCommand({
      command: { name: "model", description: "Switch model", acceptsArgs: true },
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createMockCommandInteraction({
      userId: "outsider",
      channelType: ChannelType.GuildText,
      channelId: "chan1",
      guildId: "guild1",
      guildName: "Guild",
    });
    interaction.rawData.member.roles = ["clawtributor"];

    await command.run(interaction as never);

    expect(authorizationHandler).toHaveBeenCalledTimes(1);
    expect(authorizationHandler.mock.calls[0]?.[0]).toMatchObject({
      operation: "command.invoke",
      commandName: "model",
      source: "native",
    });
    expect(authorizationHandler.mock.calls[0]?.[1]).toMatchObject({
      principal: {
        kind: "sender",
        senderId: "outsider",
        isAuthorizedSender: true,
        roleIds: ["clawtributor"],
      },
      agentId: "main",
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "Command blocked by authorization policy.",
      ephemeral: true,
    });
  });

  it("blocks a guild outsider before opening a native argument menu", async () => {
    const authorizationHandler = installOutsiderDenialPolicy();
    const cfg = createConfig();
    const command = createDiscordNativeCommand({
      command: {
        name: "think",
        description: "Set thinking level",
        acceptsArgs: true,
        args: THINK_COMMAND.args,
      },
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings: createNoopThreadBindingManager("default"),
    });
    const interaction = createMockCommandInteraction({
      userId: "outsider",
      channelType: ChannelType.GuildText,
      channelId: "chan1",
      guildId: "guild1",
      guildName: "Guild",
    });

    await command.run(interaction as never);

    expect(authorizationHandler).toHaveBeenCalledTimes(1);
    expect(authorizationHandler.mock.calls[0]?.[0]).toMatchObject({
      operation: "command.invoke",
      commandName: "think",
      source: "native",
    });
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "Command blocked by authorization policy.",
      ephemeral: true,
    });
  });

  it("reauthorizes picker navigation before loading the catalog after policy revocation", async () => {
    const cfg = createConfig();
    const threadBindings = createNoopThreadBindingManager("default");
    const pickerData = createModelsProviderData({ openai: ["gpt-4.1", "gpt-4o"] });
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockResolvedValue(pickerData);
    const interaction = createPickerInteraction();
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as never,
      cfg,
      accountId: "default",
      threadBindings,
    });
    const interactionBinding = modelPickerModule.createDiscordModelPickerInteractionBinding({
      accountId: "default",
      userId: "outsider",
      route,
    });
    const authorizationHandler = installOutsiderDenialPolicy();
    const button = createDiscordModelPickerFallbackButton({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      threadBindings,
      postApplySettleMs: 0,
    });
    const data: PickerData = {
      c: "model",
      a: "recents",
      v: "providers",
      b: interactionBinding,
      g: "1",
    };

    await button.run(interaction as unknown as PickerInteraction, data);

    expect(authorizationHandler).toHaveBeenCalledTimes(1);
    expect(authorizationHandler.mock.calls[0]?.[0]).toMatchObject({
      operation: "command.invoke",
      commandName: "model",
      source: "native",
    });
    expect(authorizationHandler.mock.calls[0]?.[1]).toMatchObject({
      principal: { kind: "sender", senderId: "outsider" },
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      conversationId: "chan1",
    });
    expect(loadSpy).not.toHaveBeenCalled();
    expect(
      listSessionEntries({
        storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain(
      "Command blocked by authorization policy",
    );
  });

  it("authorizes the selected runtime and rejects its direct mutation", async () => {
    const authorizationHandler = vi.fn((request: unknown) => {
      const runtime = (request as { arguments?: { values?: { runtime?: string } } }).arguments
        ?.values?.runtime;
      return runtime === "codex"
        ? ({ effect: "deny", code: "runtime-denied" } as const)
        : ({ effect: "pass" } as const);
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "runtime-policy",
      source: "test",
      policy: {
        id: "runtime-policy",
        description: "Deny Codex runtime mutation",
        handlers: { "command.invoke": authorizationHandler },
      },
    });
    setActivePluginRegistry(registry);
    const cfg = createConfig();
    const threadBindings = createNoopThreadBindingManager("default");
    const pickerData = createModelsProviderData({ openai: ["gpt-4.1", "gpt-4o"] });
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          { id: "codex", label: "Codex", description: "Use Codex." },
          { id: "openclaw", label: "OpenClaw", description: "Use OpenClaw." },
        ],
      ],
    ]);
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    const interaction = createPickerInteraction();
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as never,
      cfg,
      accountId: "default",
      threadBindings,
    });
    const button = createDiscordModelPickerFallbackButton({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      threadBindings,
      postApplySettleMs: 0,
    });

    await button.run(interaction as unknown as PickerInteraction, {
      c: "model",
      a: "submit",
      v: "models",
      b: modelPickerModule.createDiscordModelPickerInteractionBinding({
        accountId: "default",
        userId: "outsider",
        route,
      }),
      p: "openai",
      g: "1",
      m: modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o"),
      rt: modelPickerModule.createDiscordModelPickerRuntimeFingerprint("openai", "codex"),
    });

    expect(authorizationHandler).toHaveBeenCalledTimes(2);
    expect(authorizationHandler.mock.calls[1]?.[0]).toMatchObject({
      operation: "command.invoke",
      commandName: "model",
      source: "native",
      arguments: {
        raw: "openai/gpt-4o --runtime codex",
        values: { provider: "openai", model: "gpt-4o", runtime: "codex" },
      },
    });
    expect(
      listSessionEntries({
        storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain(
      "Command blocked by authorization policy",
    );
  });

  it("binds authorization to structured selection values when raw arguments collide", async () => {
    const authorizationHandler = vi.fn((request: unknown) => {
      const values = (request as { arguments?: { values?: Record<string, string> } }).arguments
        ?.values;
      return values?.model === "gpt-4o --runtime codex" && values.runtime === undefined
        ? ({ effect: "deny", code: "injected-model-denied" } as const)
        : ({ effect: "pass" } as const);
    });
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "structured-model-policy",
      source: "test",
      policy: {
        id: "structured-model-policy",
        description: "Deny the colliding model id, not the same raw runtime selection",
        handlers: { "command.invoke": authorizationHandler },
      },
    });
    setActivePluginRegistry(registry);
    const cfg = createConfig();
    const threadBindings = createNoopThreadBindingManager("default");
    const pickerData = createModelsProviderData({
      openai: ["gpt-4o", "gpt-4o --runtime codex"],
    });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    const hiddenDispatchSpy = vi.spyOn(nativeCommandRuntime, "dispatchReplyWithDispatcher");
    const interaction = createPickerInteraction();
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as never,
      cfg,
      accountId: "default",
      threadBindings,
    });
    const button = createDiscordModelPickerFallbackButton({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      threadBindings,
      postApplySettleMs: 0,
    });

    await button.run(interaction as unknown as PickerInteraction, {
      c: "model",
      a: "submit",
      v: "models",
      b: modelPickerModule.createDiscordModelPickerInteractionBinding({
        accountId: "default",
        userId: "outsider",
        route,
      }),
      p: "openai",
      g: "1",
      m: modelPickerModule.createDiscordModelPickerModelFingerprint(
        "openai",
        "gpt-4o --runtime codex",
      ),
    });

    expect(authorizationHandler).toHaveBeenCalledTimes(2);
    expect(authorizationHandler.mock.calls[1]?.[0]).toMatchObject({
      arguments: {
        raw: "openai/gpt-4o --runtime codex",
        values: { provider: "openai", model: "gpt-4o --runtime codex" },
      },
    });
    expect(hiddenDispatchSpy).not.toHaveBeenCalled();
    expect(
      listSessionEntries({
        storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
      }),
    ).toEqual([]);
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain(
      "Command blocked by authorization policy",
    );
  });

  it("uses authenticated channel provenance when available and omits missing provenance", async () => {
    const authorizationHandler = vi.fn(() => ({ effect: "pass" as const }));
    const registry = createEmptyPluginRegistry();
    registry.authorizationPolicies.push({
      pluginId: "context-policy",
      source: "test",
      policy: {
        id: "context-policy",
        description: "Capture model picker authorization context",
        handlers: { "command.invoke": authorizationHandler },
      },
    });
    setActivePluginRegistry(registry);
    const cfg = createConfig();
    const discordConfig = cfg.channels?.discord ?? {};
    delete discordConfig.guilds;
    const threadBindings = createNoopThreadBindingManager("default");
    const interaction = createPickerInteraction();
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as never,
      cfg,
      accountId: "default",
      threadBindings,
    });
    const channelLessInteraction = {
      ...interaction,
      channel: null,
      rawData: { ...interaction.rawData, channel_id: "signed-channel" },
      client: { fetchChannel: vi.fn().mockResolvedValue(null) },
    };

    await expect(
      authorizeDiscordModelPickerInteraction({
        interaction: channelLessInteraction as never,
        cfg,
        discordConfig,
        accountId: "default",
        route,
        commandName: "model",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(authorizationHandler.mock.calls[0]?.[1]).toMatchObject({
      conversationId: "signed-channel",
    });

    authorizationHandler.mockClear();
    delete (channelLessInteraction.rawData as { channel_id?: string }).channel_id;
    await expect(
      authorizeDiscordModelPickerInteraction({
        interaction: channelLessInteraction as never,
        cfg,
        discordConfig,
        accountId: "default",
        route,
        commandName: "model",
      }),
    ).resolves.toEqual({ allowed: true });
    expect(authorizationHandler).toHaveBeenCalledTimes(1);
    expect(authorizationHandler.mock.calls[0]?.[1]).not.toHaveProperty("conversationId");
  });

  it("rejects a concurrent thread rebind before hidden model dispatch can mutate the new session", async () => {
    const cfg = createConfig();
    const originalTarget = {
      agentId: "worker-a",
      sessionKey: "agent:worker-a:subagent:original",
    };
    const reboundTarget = {
      agentId: "worker-b",
      sessionKey: "agent:worker-b:subagent:rebound",
    };
    const bindings = createRebindableThreadBindingManager({
      threadId: "thread-race",
      initial: originalTarget,
    });
    const pickerData = createModelsProviderData({ openai: ["gpt-4.1", "gpt-4o"] });
    const interaction = createPickerInteraction();
    interaction.channel = { type: ChannelType.PublicThread, id: "thread-race" };
    (interaction.channel as typeof interaction.channel & { parentId?: string }).parentId = "chan1";
    const originalRoute = await resolveDiscordModelPickerRoute({
      interaction: interaction as never,
      cfg,
      accountId: "default",
      threadBindings: bindings.manager,
    });
    expect(originalRoute).toMatchObject(originalTarget);
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockImplementation(async () => {
      bindings.rebind(reboundTarget);
      return pickerData;
    });
    const hiddenDispatchSpy = vi
      .spyOn(nativeCommandRuntime, "dispatchReplyWithDispatcher")
      .mockImplementation(async () => {
        await upsertSessionEntry({
          storePath: resolveStorePath(cfg.session?.store, { agentId: reboundTarget.agentId }),
          sessionKey: reboundTarget.sessionKey,
          entry: {
            updatedAt: Date.now(),
            providerOverride: "openai",
            modelOverride: "gpt-4o",
          },
        });
        return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
      });
    const button = createDiscordModelPickerFallbackButton({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      threadBindings: bindings.manager,
      postApplySettleMs: 0,
    });

    await button.run(interaction as unknown as PickerInteraction, {
      c: "model",
      a: "submit",
      v: "models",
      b: modelPickerModule.createDiscordModelPickerInteractionBinding({
        accountId: "default",
        userId: "outsider",
        route: originalRoute,
      }),
      p: "openai",
      g: "1",
      m: modelPickerModule.createDiscordModelPickerModelFingerprint("openai", "gpt-4o"),
    });

    expect(hiddenDispatchSpy).not.toHaveBeenCalled();
    for (const target of [originalTarget, reboundTarget]) {
      expect(
        listSessionEntries({
          storePath: resolveStorePath(cfg.session?.store, { agentId: target.agentId }),
        }),
      ).toEqual([]);
    }
    expect(JSON.stringify(interaction.followUp.mock.calls)).toContain(
      "Model change authorization did not match this session",
    );
  });

  it("reauthorizes current guild roles before loading picker data", async () => {
    const cfg = createConfig();
    const guildConfig = cfg.channels?.discord?.guilds?.guild1;
    if (!guildConfig) {
      throw new Error("expected guild test config");
    }
    guildConfig.roles = ["role:maintainer"];
    const threadBindings = createNoopThreadBindingManager("default");
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const interaction = createPickerInteraction();
    interaction.rawData.member.roles = ["maintainer"];
    const route = await resolveDiscordModelPickerRoute({
      interaction: interaction as never,
      cfg,
      accountId: "default",
      threadBindings,
    });
    const interactionBinding = modelPickerModule.createDiscordModelPickerInteractionBinding({
      accountId: "default",
      userId: "outsider",
      route,
    });
    interaction.rawData.member.roles = [];
    const button = createDiscordModelPickerFallbackButton({
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      threadBindings,
      postApplySettleMs: 0,
    });

    await button.run(interaction as unknown as PickerInteraction, {
      c: "model",
      a: "recents",
      v: "providers",
      b: interactionBinding,
      g: "1",
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain(
      "You are not authorized to use this command",
    );
  });
});
