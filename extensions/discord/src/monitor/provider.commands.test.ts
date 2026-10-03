import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { listNativeCommandSpecsForConfig as listRealNativeCommandSpecsForConfig } from "openclaw/plugin-sdk/command-auth-native";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { danger, warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordSetupPlugin } from "../channel.setup.js";
import { DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type InteractionParams = Parameters<typeof createDiscordProviderInteractionSurface>[0];
type CreateNativeCommand = NonNullable<InteractionParams["createNativeCommand"]>;

const normalCommandSpec: NativeCommandSpec = {
  name: "normal",
  description: "Normal command",
  acceptsArgs: false,
};

function createInteractionHarness(params: {
  commandSpecs: NativeCommandSpec[];
  voiceEnabled: boolean;
  channelRuntime?: InteractionParams["channelRuntime"];
}) {
  const createNativeCommand = vi.fn(
    (options: Parameters<CreateNativeCommand>[0]): ReturnType<CreateNativeCommand> =>
      ({ name: options.command.name }) as ReturnType<CreateNativeCommand>,
  );
  const surface = createDiscordProviderInteractionSurface({
    cfg: {} as OpenClawConfig,
    discordConfig: {
      agentComponents: { enabled: false },
      execApprovals: { enabled: false },
    } as DiscordAccountConfig,
    accountId: "default",
    token: "token",
    commandSpecs: params.commandSpecs,
    nativeEnabled: true,
    voiceEnabled: params.voiceEnabled,
    groupPolicy: "open",
    useAccessGroups: false,
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
    voiceManagerRef: { current: null },
    guildEntries: undefined,
    allowFrom: [],
    dmPolicy: "open",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv,
    channelRuntime: params.channelRuntime,
    createNativeCommand,
  });
  return { createNativeCommand, surface };
}

type ResolverParams = Parameters<typeof resolveDiscordProviderCommandSpecs>[0];
type SkillCommands = ReturnType<NonNullable<ResolverParams["listSkillCommandsForAgents"]>>;

const cfg: OpenClawConfig = {};
const skillCommands = [
  { name: "skill-only", skillName: "Skill Only", description: "Skill only" },
  { name: "extra-skill", skillName: "Extra Skill", description: "Extra skill" },
];

function createResolverHarness(
  options: {
    pluginCommandSpecs?: NativeCommandSpec[];
    voiceEnabled?: boolean;
    nativeCommandSpecs?: NativeCommandSpec[];
    skillCommands?: SkillCommands;
    maxDiscordCommands?: number;
    nativeSkillsEnabled?: boolean;
  } = {},
) {
  const error = vi.fn();
  const log = vi.fn();
  const runtime: RuntimeEnv = { error, log, exit: vi.fn() };
  const configuredSkillCommands = options.skillCommands ?? skillCommands;
  const nativeCommandSpecs = options.nativeCommandSpecs ?? [
    { name: "built-in", description: "Built in", acceptsArgs: false },
  ];
  const listSkillCommandsForAgents = vi.fn(() => configuredSkillCommands);
  const listNativeCommandSpecsForConfig = vi.fn(
    (
      _config: OpenClawConfig,
      listOptions?: Parameters<NonNullable<ResolverParams["listNativeCommandSpecsForConfig"]>>[1],
    ): NativeCommandSpec[] => [
      ...nativeCommandSpecs,
      ...(listOptions?.skillCommands ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        acceptsArgs: true,
      })),
    ],
  );
  setActivePluginRegistry(createTestRegistry());
  for (const spec of options.pluginCommandSpecs ?? []) {
    expect(
      registerPluginCommand(`test-${spec.name}`, {
        name: spec.name,
        description: spec.description,
        descriptionLocalizations: spec.descriptionLocalizations,
        acceptsArgs: spec.acceptsArgs,
        channels: ["discord"],
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({ ok: true });
  }

  return {
    error,
    listNativeCommandSpecsForConfig,
    listSkillCommandsForAgents,
    log,
    resolve: () =>
      resolveDiscordProviderCommandSpecs({
        cfg,
        runtime,
        nativeEnabled: true,
        nativeSkillsEnabled: options.nativeSkillsEnabled ?? true,
        voiceEnabled: options.voiceEnabled ?? false,
        maxDiscordCommands: options.maxDiscordCommands ?? 3,
        listSkillCommandsForAgents,
        listNativeCommandSpecsForConfig,
      }),
  };
}

describe("resolveDiscordProviderCommandSpecs", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("reports only retained collisions after command overflow removes skills", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      maxDiscordCommands: 4,
      pluginCommandSpecs: [
        {
          name: "skill-only",
          description: "Plugin skill alias",
          descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
          acceptsArgs: false,
        },
        { name: "plugin-unique", description: "Unique plugin", acceptsArgs: false },
        { name: "built-in", description: "Built-in collision", acceptsArgs: false },
      ],
    });

    const resolved = await harness.resolve();

    expect(resolved.skillCommands).toEqual([]);
    expect(resolved.commandSpecs.map((command) => command.name)).toEqual([
      "built-in",
      "vc",
      "skill-only",
      "plugin-unique",
    ]);
    expect(resolved.commandSpecs[2]).toMatchObject({
      name: "skill-only",
      description: "Plugin skill alias",
      descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
      acceptsArgs: false,
    });
    expect(harness.error).toHaveBeenCalledExactlyOnceWith(
      danger(
        'discord: plugin command "/built-in" duplicates an existing native command. Skipping.',
      ),
    );
    expect(harness.listNativeCommandSpecsForConfig).toHaveBeenCalledTimes(2);
    expect(harness.log).toHaveBeenCalledOnce();
    expect(harness.log).toHaveBeenCalledWith(
      warn(
        "5 commands exceed the 4-command Discord limit; removing per-skill commands and keeping /skill.",
      ),
    );
  });

  it("retains voice ownership when a plugin claims vc", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      nativeSkillsEnabled: false,
      maxDiscordCommands: 100,
      pluginCommandSpecs: [{ name: "vc", description: "Plugin voice", acceptsArgs: false }],
    });

    const resolved = await harness.resolve();

    expect(resolved.commandSpecs.map((command) => command.name)).toEqual(["built-in", "vc"]);
    expect(resolved.commandSpecs[1]).toBe(DISCORD_VOICE_COMMAND_SPEC);
    expect(harness.error).toHaveBeenCalledOnce();
    expect(harness.error).toHaveBeenCalledWith(
      danger('discord: plugin command "/vc" duplicates an existing native command. Skipping.'),
    );
  });

  it("keeps a skill named vc from shadowing or duplicating voice", async () => {
    const vcSkillCommands: SkillCommands = [
      { name: "vc", skillName: "Voice Skill", description: "Voice skill" },
    ];
    const harness = createResolverHarness({
      voiceEnabled: true,
      maxDiscordCommands: 100,
      skillCommands: vcSkillCommands,
    });

    const resolved = await harness.resolve();

    expect(resolved.skillCommands).toEqual(vcSkillCommands);
    expect(resolved.commandSpecs.map((command) => command.name)).toEqual(["built-in", "vc"]);
    expect(resolved.commandSpecs[1]).toBe(DISCORD_VOICE_COMMAND_SPEC);
    expect(harness.error).not.toHaveBeenCalled();
    const { createNativeCommand, surface } = createInteractionHarness({
      commandSpecs: resolved.commandSpecs,
      voiceEnabled: true,
    });
    expect(createNativeCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: resolved.commandSpecs[0] }),
    );
    expect(surface.commands.map((command) => command.name)).toEqual(["built-in", "vc"]);
    expect(surface.commands[1]?.serialize().options?.map((option) => option.name)).toEqual([
      "join",
      "leave",
      "status",
    ]);
  });

  it("deduplicates provider-renamed primary specs before Discord cap planning", async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: discordSetupPlugin, source: "test" }]),
    );
    const voiceSkill: SkillCommands[number] = {
      name: "voice",
      skillName: "Voice Skill",
      description: "Skill voice",
    };
    const config: OpenClawConfig = { commands: { native: true, nativeSkills: true } };
    const rawPrimary = listRealNativeCommandSpecsForConfig(config, {
      provider: "discord",
      skillCommands: [voiceSkill],
    });
    const rawVoice = rawPrimary.filter(
      (spec) => normalizeLowercaseStringOrEmpty(spec.name) === "voice",
    );
    const uniqueCount = new Set(
      rawPrimary.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean),
    ).size;
    expect(rawVoice).toHaveLength(2);
    expect(rawVoice.map((spec) => spec.description)).toEqual([
      "Control text-to-speech (TTS).",
      "Skill voice",
    ]);
    const log = vi.fn();

    const resolved = await resolveDiscordProviderCommandSpecs({
      cfg: config,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      voiceEnabled: false,
      maxDiscordCommands: uniqueCount,
      listSkillCommandsForAgents: vi.fn(() => [voiceSkill]),
    });

    expect(resolved.skillCommands).toEqual([voiceSkill]);
    expect(resolved.commandSpecs).toHaveLength(uniqueCount);
    expect(
      resolved.commandSpecs.filter(
        (spec) => normalizeLowercaseStringOrEmpty(spec.name) === "voice",
      ),
    ).toEqual([expect.objectContaining({ description: "Control text-to-speech (TTS)." })]);
    expect(log).not.toHaveBeenCalled();
  });
  it("binds native slash commands to the owning Gateway dispatcher", () => {
    const dispatchReplyFromConfig = vi.fn();
    const buildContext = vi.fn();
    const channelRuntime = createPluginRuntimeMock({
      channel: { reply: { dispatchReplyFromConfig }, inbound: { buildContext } },
    }).channel;
    const { createNativeCommand, surface } = createInteractionHarness({
      commandSpecs: [normalCommandSpec],
      voiceEnabled: false,
      channelRuntime,
    });

    expect(surface.commands.map((command) => command.name)).toEqual(["normal"]);
    expect(createNativeCommand.mock.calls[0]?.[0].dispatchReplyFromConfig).toBe(
      dispatchReplyFromConfig,
    );
    expect(createNativeCommand.mock.calls[0]?.[0].buildContext).toBe(buildContext);
  });
});
