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
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import type { DiscordLivePolicy, DiscordLivePolicyReader } from "./live-policy.js";

const { loadModelCatalogMock } = vi.hoisted(() => ({ loadModelCatalogMock: vi.fn() }));

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
      debug: vi.fn(),
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
type CreateCommand = typeof import("./native-command.js").createDiscordNativeCommand;
let createDiscordNativeCommand: CreateCommand;
let buildDiscordCommandOptions: typeof import("./native-command.options.js").buildDiscordCommandOptions;
let nativeCommandContext: typeof import("./native-command.dispatch.test-support.js").nativeCommandContext;

function createNativeCommand(
  spec: string | Parameters<CreateCommand>[0]["command"],
  { cfg = {}, readPolicy }: { readPolicy?: DiscordLivePolicyReader; cfg?: OpenClawConfig } = {},
): ReturnType<CreateCommand> {
  const command =
    typeof spec === "string"
      ? listNativeCommandSpecs({ provider: "discord" }).find((entry) => entry.name === spec)
      : spec;
  if (!command) {
    throw new Error(`missing native command: ${typeof spec === "string" ? spec : spec.name}`);
  }
  return createDiscordNativeCommand({
    readPolicy,
    command,
    ...nativeCommandContext(cfg),
    ephemeralDefault: true,
  });
}

function autocompleteFor(command: Pick<ReturnType<CreateCommand>, "options">, name = "level") {
  const option = command.options?.find((entry) => entry.name === name);
  const autocomplete = option && "autocomplete" in option ? option.autocomplete : undefined;
  if (typeof autocomplete !== "function") {
    throw new Error(`missing autocomplete: ${name}`);
  }
  return autocomplete as (interaction: unknown) => Promise<unknown>;
}

type CommandArg = NonNullable<ChatCommandDefinition["args"]>[number];

function pluginCommand(name: string, arg: Partial<CommandArg>, cfg: OpenClawConfig) {
  return createNativeCommand(
    {
      name,
      description: name,
      acceptsArgs: true,
      args: [
        { name: "value", description: "Value", type: "string", preferAutocomplete: true, ...arg },
      ],
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
          "guild-1": { channels: { "channel-1": { enabled: true, requireMention: false } } },
        },
      },
    },
  };
}

function autocompleteInteraction({
  userId = "owner",
  channelType = ChannelType.DM,
  channelId = "dm-1",
  guildId,
  focusedValue = "",
}: {
  userId?: string;
  channelType?: ChannelType;
  channelId?: string;
  guildId?: string;
  focusedValue?: string;
} = {}) {
  return {
    user: { id: userId, username: userId, globalName: userId },
    channel: { type: channelType, id: channelId, name: channelId },
    guild: guildId ? { id: guildId } : undefined,
    rawData: { member: { roles: [] } },
    options: { getFocused: () => ({ value: focusedValue }) },
    respond: vi.fn(async (_choices: unknown[]) => undefined),
    client: {},
  };
}

const expectedChoices = (...values: string[]) => values.map((value) => ({ name: value, value }));
const dmConfig = (dmPolicy: "pairing" | "disabled"): OpenClawConfig => ({
  channels: { discord: { dmPolicy, allowFrom: [] } },
});

async function runAutocomplete(
  autocomplete: (interaction: unknown) => Promise<unknown>,
  params?: Parameters<typeof autocompleteInteraction>[0],
) {
  const interaction = autocompleteInteraction(params);
  await autocomplete(interaction);
  return interaction.respond;
}

const blockedGuildMember = {
  userId: "blocked-user",
  channelType: ChannelType.GuildText,
  channelId: "channel-1",
  guildId: "guild-1",
};

beforeAll(async () => {
  ({ listNativeCommandSpecs } = await import("openclaw/plugin-sdk/command-auth-native"));
  ({ createDiscordNativeCommand } = await import("./native-command.js"));
  ({ buildDiscordCommandOptions } = await import("./native-command.options.js"));
  ({ nativeCommandContext } = await import("./native-command.dispatch.test-support.js"));
});

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  loadModelCatalogMock.mockReset().mockReturnValue({ entries: [], routeVariants: [] });
});

afterEach(clearRuntimeConfigSnapshot);

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
  },
);

it("uses autocomplete for /acp action so inline action values are accepted", async () => {
  const command = createNativeCommand("acp");
  const action = command.options?.find((option) => option.name === "action");
  expect(action && "choices" in action ? action.choices : undefined).toBeUndefined();
  const respond = await runAutocomplete(autocompleteFor(command, "action"), { focusedValue: "st" });
  expect(respond).toHaveBeenCalledWith(expectedChoices("steer", "status", "install"));
});

it("matches canonically equivalent autocomplete labels without rewriting them", async () => {
  const label = "Mu\u0308nchen";
  const options = buildDiscordCommandOptions({
    command: {
      key: "canonical",
      description: "Canonical",
      textAliases: ["/canonical"],
      scope: "both",
      args: [
        {
          name: "value",
          description: "Value",
          type: "string",
          choices: () => [{ value: "nfc", label }],
          preferAutocomplete: true,
        },
      ],
    },
    cfg: {},
    authorizeChoiceContext: async () => true,
    resolveChoiceContext: async () => ({ provider: "openai", model: "gpt-5.6-luna" }),
  });
  const respond = await runAutocomplete(autocompleteFor({ options }, "value"), {
    focusedValue: "München",
  });
  expect(respond).toHaveBeenCalledWith([{ name: label, value: "nfc" }]);
});

it("passes the effective agent runtime into dynamic /think choices", async () => {
  let agentRuntime = "codex";
  const options = buildDiscordCommandOptions({
    command: {
      key: "think",
      description: "Think",
      textAliases: ["/think"],
      scope: "both",
      args: [
        {
          name: "level",
          description: "Level",
          type: "string",
          choices: ({ agentRuntime: selectedRuntime }) =>
            selectedRuntime === "openclaw" ? ["max", "ultra"] : ["max"],
        },
      ],
    },
    cfg: {},
    authorizeChoiceContext: async () => true,
    resolveChoiceContext: async () => ({
      provider: "openai",
      model: "gpt-5.6-luna",
      agentId: "agent-a",
      agentRuntime,
    }),
  });
  const autocomplete = autocompleteFor({ options });
  const codexRespond = await runAutocomplete(autocomplete);
  expect(codexRespond).toHaveBeenCalledWith(expectedChoices("max"));
  expect(loadModelCatalogMock).toHaveBeenCalledWith({
    config: {},
    agentId: "agent-a",
    agentDir: "/tmp/agents/agent-a/agent",
  });

  agentRuntime = "openclaw";
  const openclawRespond = await runAutocomplete(autocomplete);
  expect(openclawRespond).toHaveBeenCalledWith(expectedChoices("max", "ultra"));
});

it("returns empty autocomplete before its deadline when policy later rejects", async () => {
  vi.useFakeTimers();
  try {
    const pendingPolicy = createDeferred<DiscordLivePolicy>();
    const autocomplete = autocompleteFor(
      createNativeCommand("think", { readPolicy: () => pendingPolicy.promise }),
    );
    const interaction = autocompleteInteraction({ userId: "123456789", channelId: "dm-channel" });
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
  const cfg = dmConfig("pairing");
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
  const autocomplete = autocompleteFor(command);
  try {
    const run = runAutocomplete(autocomplete, { userId: "123456789", channelId: "dm-channel" });
    await readStarted.promise;
    loadModelCatalogMock.mockClear();
    const revoked = dmConfig("disabled");
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

it("keeps plugin command autocomplete aligned with dispatch owner checks", async () => {
  const command = pluginCommand(
    "pair",
    {
      name: "mode",
      choices: () => [
        { label: "fast", value: "fast" },
        { label: "secure", value: "secure" },
      ],
    },
    createAllowedGuildAutocompleteConfig({ ownerAllowFrom: ["discord:owner-user"] }),
  );
  const respond = await runAutocomplete(autocompleteFor(command, "mode"), blockedGuildMember);
  expect(respond).toHaveBeenCalledWith(expectedChoices("fast", "secure"));
});

it("refreshes autocomplete authorization and dynamic choices between invocations", async () => {
  const sourceCfg: OpenClawConfig = {
    session: { dmScope: "main" },
    channels: { discord: { dm: { enabled: true }, dmPolicy: "disabled" } },
  };
  const runtimeCfg: OpenClawConfig = {
    session: { dmScope: "per-channel-peer" },
    channels: { discord: { dm: { enabled: true }, dmPolicy: "open", allowFrom: ["*"] } },
  };
  const command = pluginCommand(
    "scope",
    {
      choices: ({ cfg }: { cfg?: OpenClawConfig }) => {
        const dmScope = cfg?.session?.dmScope ?? "missing";
        return [{ label: dmScope, value: dmScope }];
      },
    },
    sourceCfg,
  );
  const autocomplete = autocompleteFor(command, "value");
  const blockedRespond = await runAutocomplete(autocomplete);
  expect(blockedRespond).toHaveBeenCalledWith([]);
  setRuntimeConfigSnapshot(runtimeCfg, runtimeCfg);
  const refreshedRespond = await runAutocomplete(autocomplete);
  expect(refreshedRespond).toHaveBeenCalledWith(expectedChoices("per-channel-peer"));
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
      commands: { allowFrom: { discord: ["user:allowed-user"] } },
    },
  });
  const respond = await runAutocomplete(autocompleteFor(command), {
    userId: "allowed-user",
    channelType: ChannelType.GroupDM,
    channelId: "blocked-group",
    focusedValue: "xh",
  });
  expect(respond).toHaveBeenCalledWith([]);
});

it("serializes localized command descriptions on a UTF-16 boundary", () => {
  const localized = { ko: "현지화된 설명", "en-GB": "k".repeat(99) };
  const command = createNativeCommand({
    name: "localized",
    description: "Default description",
    descriptionLocalizations: { ...localized, "en-GB": `${localized["en-GB"]}😀 trailing` },
    acceptsArgs: false,
  });

  expect(command.descriptionLocalizations).toEqual(localized);
  expect(command.serialize()).toEqual({
    name: "localized",
    description: "Default description",
    description_localizations: localized,
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
installDiscordIngressTestRuntime();

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
