import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import * as commandAuthNative from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { danger, warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discordSetupPlugin } from "../channel.setup.js";
import { DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import * as nativeCommandRuntime from "./native-command.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type InteractionParams = Parameters<typeof createDiscordProviderInteractionSurface>[0];

const command = (name: string, description = name): NativeCommandSpec => ({
  name,
  description,
  acceptsArgs: false,
});
const names = (specs: readonly { name: string }[]) => specs.map(({ name }) => name);
const skill = (name: string, skillName = name, description = name) => ({
  name,
  skillName,
  description,
});
const paddingSkills = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => skill(`${prefix}-${index}`));

function createInteractionHarness(params: {
  commandSpecs: NativeCommandSpec[];
  voiceEnabled: boolean;
  channelRuntime?: InteractionParams["channelRuntime"];
}) {
  const createNativeCommand = vi
    .spyOn(nativeCommandRuntime, "createDiscordNativeCommand")
    .mockImplementation(
      ({ command: spec }) =>
        ({ name: spec.name }) as ReturnType<typeof nativeCommandRuntime.createDiscordNativeCommand>,
    );
  const surface = createDiscordProviderInteractionSurface({
    cfg: {},
    discordConfig: {
      agentComponents: { enabled: false },
      execApprovals: { enabled: false },
    },
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

const skillCommands = [skill("skill-only"), skill("extra-skill")];

function createResolverHarness(
  options: {
    pluginCommandSpecs?: NativeCommandSpec[];
    voiceEnabled?: boolean;
    skillCommands?: SkillCommands;
    nativeSkillsEnabled?: boolean;
  } = {},
) {
  const error = vi.fn();
  const log = vi.fn();
  const runtime: RuntimeEnv = { error, log, exit: vi.fn() };
  const configuredSkillCommands = options.skillCommands ?? skillCommands;
  vi.spyOn(commandAuthNative, "prepareSkillCommandsForAgents").mockResolvedValue(
    configuredSkillCommands,
  );
  const listNativeCommandSpecsForConfig = vi
    .spyOn(commandAuthNative, "listNativeCommandSpecsForConfig")
    .mockImplementation((_config, listOptions): NativeCommandSpec[] => [
      command("built-in"),
      ...(listOptions?.skillCommands ?? []).map(({ name, description }) => ({
        name,
        description,
        acceptsArgs: true,
      })),
    ]);
  setActivePluginRegistry(createTestRegistry());
  for (const spec of options.pluginCommandSpecs ?? []) {
    expect(
      registerPluginCommand(`test-${spec.name}`, {
        ...spec,
        channels: ["discord"],
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({ ok: true });
  }

  return {
    error,
    listNativeCommandSpecsForConfig,
    log,
    resolve: () =>
      resolveDiscordProviderCommandSpecs({
        cfg: {},
        runtime,
        nativeEnabled: true,
        nativeSkillsEnabled: options.nativeSkillsEnabled ?? true,
        voiceEnabled: options.voiceEnabled ?? false,
      }),
  };
}

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
    skillCommands: [...skillCommands, ...paddingSkills("overflow-skill", 96)],
    pluginCommandSpecs: [
      {
        ...command("skill-only", "Plugin skill alias"),
        descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
      },
      command("plugin-unique"),
      command("built-in"),
    ],
  });

  const resolved = await harness.resolve();

  expect(resolved.skillCommands).toEqual([]);
  expect(names(resolved.commandSpecs)).toEqual(["built-in", "vc", "skill-only", "plugin-unique"]);
  expect(resolved.commandSpecs[2]).toMatchObject({
    name: "skill-only",
    description: "Plugin skill alias",
    descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
    acceptsArgs: false,
  });
  expect(harness.error).toHaveBeenCalledExactlyOnceWith(
    danger('discord: plugin command "/built-in" duplicates an existing native command. Skipping.'),
  );
  expect(harness.listNativeCommandSpecsForConfig).toHaveBeenCalledTimes(2);
  expect(harness.log).toHaveBeenCalledExactlyOnceWith(
    warn(
      "101 commands exceed the 100-command Discord limit; removing per-skill commands and keeping /skill.",
    ),
  );
});

it.each(["plugin", "skill"])("retains voice ownership against a %s named vc", async (source) => {
  const fromPlugin = source === "plugin";
  const vcSkillCommands = [skill("vc")];
  const harness = createResolverHarness({
    voiceEnabled: true,
    nativeSkillsEnabled: !fromPlugin,
    pluginCommandSpecs: fromPlugin ? [command("vc")] : [],
    skillCommands: fromPlugin ? undefined : vcSkillCommands,
  });

  const resolved = await harness.resolve();

  expect(names(resolved.commandSpecs)).toEqual(["built-in", "vc"]);
  expect(resolved.commandSpecs[1]).toBe(DISCORD_VOICE_COMMAND_SPEC);
  if (fromPlugin) {
    expect(harness.error).toHaveBeenCalledExactlyOnceWith(
      danger('discord: plugin command "/vc" duplicates an existing native command. Skipping.'),
    );
    return;
  }
  expect(resolved.skillCommands).toEqual(vcSkillCommands);
  expect(harness.error).not.toHaveBeenCalled();
  const { createNativeCommand, surface } = createInteractionHarness({
    commandSpecs: resolved.commandSpecs,
    voiceEnabled: true,
  });
  expect(createNativeCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: resolved.commandSpecs[0] }),
  );
  expect(names(surface.commands)).toEqual(["built-in", "vc"]);
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
  const voiceSkill = skill("voice", "Voice Skill", "Skill voice");
  const config: OpenClawConfig = { commands: { native: true, nativeSkills: true } };
  const primary = (commands: SkillCommands) =>
    commandAuthNative.listNativeCommandSpecsForConfig(config, {
      provider: "discord",
      skillCommands: commands,
    });
  const uniqueCount = (specs: NativeCommandSpec[]) =>
    new Set(names(specs).map(normalizeLowercaseStringOrEmpty).filter(Boolean)).size;
  const voiceSpecs = (specs: NativeCommandSpec[]) =>
    specs.filter((spec) => normalizeLowercaseStringOrEmpty(spec.name) === "voice");
  const cappedSkillCommands: SkillCommands = [
    voiceSkill,
    ...paddingSkills("cap-padding", 100 - uniqueCount(primary([voiceSkill]))),
  ];
  const rawPrimary = primary(cappedSkillCommands);
  const rawVoice = voiceSpecs(rawPrimary);
  expect(uniqueCount(rawPrimary)).toBe(100);
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
  expect(resolved.commandSpecs).toHaveLength(uniqueCount(rawPrimary));
  expect(voiceSpecs(resolved.commandSpecs)).toEqual([
    expect.objectContaining({ description: "Control text-to-speech (TTS)." }),
  ]);
  expect(log).not.toHaveBeenCalled();
});
it("binds native slash commands to the owning Gateway dispatcher", () => {
  const dispatchReplyFromConfig = vi.fn();
  const buildContext = vi.fn();
  const channelRuntime = createPluginRuntimeMock({
    channel: { reply: { dispatchReplyFromConfig }, inbound: { buildContext } },
  }).channel;
  const { createNativeCommand, surface } = createInteractionHarness({
    commandSpecs: [command("normal")],
    voiceEnabled: false,
    channelRuntime,
  });

  expect(names(surface.commands)).toEqual(["normal"]);
  expect(createNativeCommand.mock.calls[0]?.[0].dispatchReplyFromConfig).toBe(
    dispatchReplyFromConfig,
  );
  expect(createNativeCommand.mock.calls[0]?.[0].buildContext).toBe(buildContext);
});
