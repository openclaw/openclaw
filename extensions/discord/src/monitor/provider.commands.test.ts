import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import * as commandAuthNative from "openclaw/plugin-sdk/command-auth-native";
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
import * as nativeCommandRuntime from "./native-command.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type InteractionParams = Parameters<typeof createDiscordProviderInteractionSurface>[0];
type CreateNativeCommand = typeof nativeCommandRuntime.createDiscordNativeCommand;

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
  const createNativeCommand = vi
    .spyOn(nativeCommandRuntime, "createDiscordNativeCommand")
    .mockImplementation(
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
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
    voiceManagerRef: { current: null },
    guildEntries: undefined,
    allowFrom: [],
    dmPolicy: "open",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv,
    channelRuntime: params.channelRuntime,
  });
  return { createNativeCommand, surface };
}

type SkillCommands = Awaited<ReturnType<typeof commandAuthNative.prepareSkillCommandsForAgents>>;

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
  const prepareSkillCommandsForAgents = vi
    .spyOn(commandAuthNative, "prepareSkillCommandsForAgents")
    .mockImplementation(async () => configuredSkillCommands);
  const listNativeCommandSpecsForConfig = vi
    .spyOn(commandAuthNative, "listNativeCommandSpecsForConfig")
    .mockImplementation(
      (
        _config: OpenClawConfig,
        listOptions?: Parameters<typeof commandAuthNative.listNativeCommandSpecsForConfig>[1],
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
    prepareSkillCommandsForAgents,
    log,
    resolve: () =>
      resolveDiscordProviderCommandSpecs({
        cfg,
        runtime,
        nativeEnabled: true,
        nativeSkillsEnabled: options.nativeSkillsEnabled ?? true,
        voiceEnabled: options.voiceEnabled ?? false,
      }),
  };
}

describe("resolveDiscordProviderCommandSpecs", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("reports only retained collisions after command overflow removes skills", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      skillCommands: [
        ...skillCommands,
        ...Array.from({ length: 96 }, (_, index) => ({
          name: `overflow-skill-${index}`,
          skillName: `Overflow Skill ${index}`,
          description: "Overflow skill",
        })),
      ],
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
        "101 commands exceed the 100-command Discord limit; removing per-skill commands and keeping /skill.",
      ),
    );
  });

  it("retains voice ownership when a plugin claims vc", async () => {
    const harness = createResolverHarness({
      voiceEnabled: true,
      nativeSkillsEnabled: false,
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
    const baselinePrimary = commandAuthNative.listNativeCommandSpecsForConfig(config, {
      provider: "discord",
      skillCommands: [voiceSkill],
    });
    const baselineUniqueCount = new Set(
      baselinePrimary.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean),
    ).size;
    const cappedSkillCommands: SkillCommands = [
      voiceSkill,
      ...Array.from({ length: 100 - baselineUniqueCount }, (_, index) => ({
        name: `cap-padding-${index}`,
        skillName: `Cap Padding ${index}`,
        description: "Cap padding skill",
      })),
    ];
    const rawPrimary = commandAuthNative.listNativeCommandSpecsForConfig(config, {
      provider: "discord",
      skillCommands: cappedSkillCommands,
    });
    const rawVoice = rawPrimary.filter(
      (spec) => normalizeLowercaseStringOrEmpty(spec.name) === "voice",
    );
    const uniqueCount = new Set(
      rawPrimary.map((spec) => normalizeLowercaseStringOrEmpty(spec.name)).filter(Boolean),
    ).size;
    expect(uniqueCount).toBe(100);
    expect(rawPrimary).toHaveLength(101);
    expect(rawVoice).toHaveLength(2);
    expect(rawVoice.map((spec) => spec.description)).toEqual([
      "Control text-to-speech (TTS).",
      "Skill voice",
    ]);
    const log = vi.fn();
    vi.spyOn(commandAuthNative, "prepareSkillCommandsForAgents").mockResolvedValue(
      cappedSkillCommands,
    );

    const resolved = await resolveDiscordProviderCommandSpecs({
      cfg: config,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      voiceEnabled: false,
    });

    expect(resolved.skillCommands).toEqual(cappedSkillCommands);
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
