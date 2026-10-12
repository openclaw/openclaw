// Discord tests cover native command.options plugin behavior.
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  InteractionContextType,
} from "discord-api-types/v10";
import type { ChatCommandDefinition } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useBundledProviderPolicyArtifactsForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import type { DiscordLivePolicy, DiscordLivePolicyReader } from "./live-policy.js";

const { loadModelCatalogMock, loggerDebugMock } = vi.hoisted(() => ({
  loadModelCatalogMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: () => ({
      child: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: loggerDebugMock,
    }),
    logVerbose: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  getPreparedModelCatalogSnapshot: loadModelCatalogMock,
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/agents/${agentId}/agent`,
  resolveAgentWorkspaceDir: (_cfg: OpenClawConfig, agentId: string) => `/tmp/workspaces/${agentId}`,
  resolveHumanDelayConfig: () => undefined,
}));

let listNativeCommandSpecs: typeof import("openclaw/plugin-sdk/command-auth-native").listNativeCommandSpecs;
let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;
let buildDiscordCommandOptions: typeof import("./native-command.options.js").buildDiscordCommandOptions;
let resolveDiscordNativeAutocompleteAuthorized: typeof import("./native-command-auth.js").resolveDiscordNativeAutocompleteAuthorized;
let createNoopThreadBindingManager: typeof import("./thread-bindings.js").createNoopThreadBindingManager;

function createNativeCommand(
  spec: string | Parameters<typeof createDiscordNativeCommand>[0]["command"],
  opts?: {
    readPolicy?: DiscordLivePolicyReader;
    cfg?: OpenClawConfig;
  },
): ReturnType<typeof import("./native-command.js").createDiscordNativeCommand> {
  let command = spec;
  if (typeof command === "string") {
    const name = command;
    const resolved = listNativeCommandSpecs({ provider: "discord" }).find(
      (entry) => entry.name === name,
    );
    if (!resolved) {
      throw new Error(`missing native command: ${name}`);
    }
    command = resolved;
  }
  const cfg = opts?.cfg ?? {};
  return createDiscordNativeCommand({
    readPolicy: opts?.readPolicy,
    command,
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

type CommandOption = NonNullable<
  ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>["options"]
>[number];

function requireOption(
  command: ReturnType<typeof import("./native-command.js").createDiscordNativeCommand>,
  name: string,
): CommandOption {
  const option = command.options?.find((entry) => entry.name === name);
  if (!option) {
    throw new Error(`missing command option: ${name}`);
  }
  return option;
}

function readAutocomplete(option: CommandOption | undefined): unknown {
  return option && "autocomplete" in option ? option.autocomplete : undefined;
}

function readChoices(option: CommandOption | undefined): unknown[] | undefined {
  const value = option && "choices" in option ? option.choices : undefined;
  return Array.isArray(value) ? value : undefined;
}

function requireAutocomplete(option: CommandOption) {
  const autocomplete = readAutocomplete(option);
  if (typeof autocomplete !== "function") {
    throw new Error(`missing autocomplete: ${option.name}`);
  }
  return autocomplete as (interaction: unknown) => Promise<unknown>;
}

function pluginCommand(
  name: string,
  arg: NonNullable<ChatCommandDefinition["args"]>[number],
  cfg: OpenClawConfig,
) {
  return createNativeCommand(
    {
      name,
      description: name,
      acceptsArgs: true,
      args: [arg],
      requireAuth: true,
      prepareDispatch: () => ({
        kind: "plugin" as const,
        invocation: { runtime: { execute: vi.fn() }, selection: Object.freeze({}) },
      }),
    } as never,
    { cfg },
  );
}

function createAllowedGuildAutocompleteConfig(
  commands: NonNullable<OpenClawConfig["commands"]>,
): OpenClawConfig {
  return {
    commands,
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "guild-1": {
            channels: {
              "channel-1": {
                enabled: true,
                requireMention: false,
              },
            },
          },
        },
      },
    },
  };
}

function autocompleteInteraction(
  params: {
    userId?: string;
    username?: string;
    globalName?: string;
    channelType?: ChannelType;
    channelId?: string;
    channelName?: string;
    guildId?: string;
    focusedValue?: string;
  } = {},
) {
  const respond = vi.fn(async (_choices: unknown[]) => undefined);

  return {
    user: {
      id: params.userId ?? "owner",
      username: params.username ?? params.userId ?? "owner",
      globalName: params.globalName ?? params.userId ?? "owner",
    },
    channel: {
      type: params.channelType ?? ChannelType.DM,
      id: params.channelId ?? "dm-1",
      name: params.channelName ?? params.channelId ?? "dm-1",
    },
    guild: params.guildId ? { id: params.guildId } : undefined,
    rawData: {
      member: { roles: [] },
    },
    options: {
      getFocused: () => ({ value: params.focusedValue ?? "" }),
    },
    respond,
    client: {},
  };
}

async function runAutocomplete(
  autocomplete: (interaction: unknown) => Promise<unknown>,
  params?: Parameters<typeof autocompleteInteraction>[0],
) {
  const interaction = autocompleteInteraction(params);
  await autocomplete(interaction);
  return interaction.respond;
}

describe("createDiscordNativeCommand option wiring", () => {
  beforeAll(async () => {
    ({ listNativeCommandSpecs } = await import("openclaw/plugin-sdk/command-auth-native"));
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
    ({ buildDiscordCommandOptions } = await import("./native-command.options.js"));
    ({ resolveDiscordNativeAutocompleteAuthorized } = await import("./native-command-auth.js"));
    ({ createNoopThreadBindingManager } = await import("./thread-bindings.js"));
  });

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    loadModelCatalogMock.mockReset().mockReturnValue({ entries: [], routeVariants: [] });
    loggerDebugMock.mockReset();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it.each([
    ["number", true, ApplicationCommandOptionType.Number],
    ["boolean", undefined, ApplicationCommandOptionType.Boolean],
  ] as const)(
    "serializes %s options with required=%s before resolving choices",
    (type, required, expectedType) => {
      const choices = vi.fn(() => ["unused"]);
      const description = "x".repeat(99) + "😀 trailing";
      const command = createNativeCommand({
        name: "scalar",
        description: "Scalar option",
        acceptsArgs: true,
        args: [{ name: "value", description, type, required, choices, preferAutocomplete: true }],
      });

      expect(command.serializeOptions()).toEqual([
        {
          name: "value",
          description: "x".repeat(99),
          type: expectedType,
          required: required ?? false,
        },
      ]);
      expect(choices).not.toHaveBeenCalled();
      expect(loggerDebugMock).toHaveBeenCalledExactlyOnceWith(
        `discord: truncating native command description (command:scalar arg:value) from ${description.length} to 100: ${JSON.stringify(description)}`,
      );
    },
  );

  it("uses autocomplete for /acp action so inline action values are accepted", async () => {
    const command = createNativeCommand("acp");
    const action = requireOption(command, "action");
    const autocomplete = requireAutocomplete(action);

    expect(readChoices(action)).toBeUndefined();
    const respond = await runAutocomplete(autocomplete, {
      username: "tester",
      globalName: "Tester",
      focusedValue: "st",
    });
    expect(respond).toHaveBeenCalledWith([
      { name: "steer", value: "steer" },
      { name: "status", value: "status" },
      { name: "install", value: "install" },
    ]);
  });

  it("passes the effective agent runtime into dynamic /think choices", async () => {
    let agentRuntime = "codex";
    const command: ChatCommandDefinition = {
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
          choices: ({ agentRuntime: selectedRuntime }) => [
            "max",
            ...(selectedRuntime === "openclaw" ? ["ultra"] : []),
          ],
        },
      ],
      argsParsing: "positional",
      argsMenu: "auto",
      scope: "both",
    };
    const options = buildDiscordCommandOptions({
      command,
      cfg: {},
      authorizeChoiceContext: async () => true,
      resolveChoiceContext: async () => ({
        provider: "openai",
        model: "gpt-5.6-luna",
        agentId: "agent-a",
        agentRuntime,
      }),
    });
    const level = options?.find((option) => option.name === "level");
    if (!level) {
      throw new Error("missing runtime-aware thinking option");
    }
    const autocomplete = requireAutocomplete(level);

    const codexRespond = await runAutocomplete(autocomplete);
    expect(codexRespond).toHaveBeenCalledWith([{ name: "max", value: "max" }]);
    expect(loadModelCatalogMock).toHaveBeenCalledWith({
      config: {},
      agentId: "agent-a",
      agentDir: "/tmp/agents/agent-a/agent",
    });

    agentRuntime = "openclaw";
    const openclawRespond = await runAutocomplete(autocomplete);
    expect(openclawRespond).toHaveBeenCalledWith([
      { name: "max", value: "max" },
      { name: "ultra", value: "ultra" },
    ]);
  });

  it("returns empty autocomplete before its deadline when policy later rejects", async () => {
    vi.useFakeTimers();
    try {
      const pendingPolicy = createDeferred<DiscordLivePolicy>();
      const command = createNativeCommand("think", { readPolicy: () => pendingPolicy.promise });
      const autocomplete = requireAutocomplete(requireOption(command, "level"));
      const interaction = autocompleteInteraction({
        userId: "123456789",
        username: "AgentUser",
        channelId: "dm-channel",
      });
      const { respond } = interaction;
      const run = autocomplete(interaction);

      await vi.advanceTimersByTimeAsync(1_001);

      expect(respond).toHaveBeenCalledExactlyOnceWith([]);
      await run;
      pendingPolicy.reject(new Error("late autocomplete policy failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(respond).toHaveBeenCalledExactlyOnceWith([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns empty autocomplete when access is revoked during the pairing-store read", async () => {
    const dmAuth = await import("./dm-command-auth.js");
    const resolveDmAccess = dmAuth.resolveDiscordDmCommandAccess;
    const stored = createDeferred<string[]>();
    const readStarted = createDeferred<void>();
    const authSpy = vi.spyOn(dmAuth, "resolveDiscordDmCommandAccess").mockImplementation((params) =>
      resolveDmAccess({
        ...params,
        readStoreAllowFrom: async () => {
          readStarted.resolve();
          return await stored.promise;
        },
      }),
    );
    const cfg: OpenClawConfig = {
      channels: { discord: { dmPolicy: "pairing", allowFrom: [] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const command = createNativeCommand("think", {
      cfg,
      readPolicy: createDiscordLivePolicyReader({
        cfg,
        accountId: "default",
        token: "synthetic-token",
        resolvedAllowlist: { guildEntries: undefined, allowFrom: [] },
      }),
    });
    const autocomplete = requireAutocomplete(requireOption(command, "level"));
    try {
      const run = runAutocomplete(autocomplete, {
        userId: "123456789",
        channelId: "dm-channel",
      });
      await readStarted.promise;
      loadModelCatalogMock.mockClear();
      const revoked: OpenClawConfig = {
        channels: { discord: { dmPolicy: "disabled", allowFrom: [] } },
      };
      setRuntimeConfigSnapshot(revoked, revoked);
      stored.resolve(["123456789"]);
      const respond = await run;

      expect(respond).toHaveBeenCalledExactlyOnceWith([]);
      expect(loadModelCatalogMock).not.toHaveBeenCalled();
    } finally {
      stored.resolve([]);
      authSpy.mockRestore();
      clearRuntimeConfigSnapshot();
    }
  });

  it("rejects autocomplete when commands.ownerAllowFrom rejects the sender", async () => {
    const cfg = createAllowedGuildAutocompleteConfig({ ownerAllowFrom: ["discord:owner-user"] });
    await expect(
      resolveDiscordNativeAutocompleteAuthorized({
        cfg,
        discordConfig: cfg.channels?.discord ?? {},
        accountId: "default",
        interaction: autocompleteInteraction({
          userId: "blocked-user",
          username: "blocked",
          globalName: "Blocked",
          channelType: ChannelType.GuildText,
          channelId: "channel-1",
          channelName: "general",
          guildId: "guild-1",
        }) as never,
      }),
    ).resolves.toBe(false);
  });

  it("keeps plugin command autocomplete aligned with dispatch owner checks", async () => {
    const command = pluginCommand(
      "pair",
      {
        name: "mode",
        description: "Pairing mode",
        type: "string",
        preferAutocomplete: true,
        choices: () => [
          { label: "fast", value: "fast" },
          { label: "secure", value: "secure" },
        ],
      },
      createAllowedGuildAutocompleteConfig({ ownerAllowFrom: ["discord:owner-user"] }),
    );
    const mode = requireOption(command, "mode");
    const autocomplete = requireAutocomplete(mode);
    const respond = await runAutocomplete(autocomplete, {
      userId: "blocked-user",
      username: "blocked",
      globalName: "Blocked",
      channelType: ChannelType.GuildText,
      channelId: "channel-1",
      channelName: "general",
      guildId: "guild-1",
    });

    expect(respond).toHaveBeenCalledWith([
      { name: "fast", value: "fast" },
      { name: "secure", value: "secure" },
    ]);
  });

  it("refreshes autocomplete authorization and dynamic choices between invocations", async () => {
    const sourceCfg: OpenClawConfig = {
      session: { dmScope: "main" },
      channels: {
        discord: {
          dm: { enabled: true },
          dmPolicy: "disabled",
        },
      },
    };
    const runtimeCfg: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        discord: {
          dm: { enabled: true },
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    };
    const command = pluginCommand(
      "scope",
      {
        name: "value",
        description: "Scope value",
        type: "string",
        preferAutocomplete: true,
        choices: ({ cfg }: { cfg?: OpenClawConfig }) => {
          const dmScope = cfg?.session?.dmScope ?? "missing";
          return [{ label: dmScope, value: dmScope }];
        },
      },
      sourceCfg,
    );
    const value = requireOption(command, "value");
    const autocomplete = requireAutocomplete(value);

    const blockedRespond = await runAutocomplete(autocomplete);
    expect(blockedRespond).toHaveBeenCalledWith([]);

    setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
    const refreshedRespond = await runAutocomplete(autocomplete);
    expect(refreshedRespond).toHaveBeenCalledWith([
      { name: "per-channel-peer", value: "per-channel-peer" },
    ]);
  });

  it("returns no autocomplete choices for group DMs outside dm.groupChannels", async () => {
    const command = createNativeCommand("think", {
      cfg: {
        channels: {
          discord: {
            dmPolicy: "open",
            dm: { enabled: true, groupEnabled: true, groupChannels: ["allowed-group"] },
          },
        },
        commands: {
          allowFrom: {
            discord: ["user:allowed-user"],
          },
        },
      },
    });
    const level = requireOption(command, "level");
    const autocomplete = requireAutocomplete(level);
    const respond = await runAutocomplete(autocomplete, {
      userId: "allowed-user",
      username: "allowed",
      globalName: "Allowed",
      channelType: ChannelType.GroupDM,
      channelId: "blocked-group",
      channelName: "Blocked Group",
      focusedValue: "xh",
    });

    expect(respond).toHaveBeenCalledWith([]);
  });

  it("serializes localized command descriptions on a UTF-16 boundary", () => {
    const longDescription = `${"k".repeat(99)}😀 trailing`;
    const command = createNativeCommand({
      name: "localized",
      description: "Default description",
      descriptionLocalizations: {
        ko: "현지화된 설명",
        "en-GB": longDescription,
      },
      acceptsArgs: false,
    });

    expect(command.descriptionLocalizations).toEqual({
      ko: "현지화된 설명",
      "en-GB": "k".repeat(99),
    });
    expect(command.serialize()).toEqual({
      name: "localized",
      description: "Default description",
      description_localizations: {
        ko: "현지화된 설명",
        "en-GB": "k".repeat(99),
      },
      type: ApplicationCommandType.ChatInput,
      integration_types: [0, 1],
      contexts: [
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ],
      default_member_permissions: null,
    });
  });
});

installDiscordIngressTestRuntime();

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
