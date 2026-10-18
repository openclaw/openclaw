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
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { discordSetupPlugin } from "../channel.setup.js";
import { DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import * as nativeCommandRuntime from "./native-command.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";
import { createDiscordProviderInteractionSurface } from "./provider.interactions.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type InteractionParams = Parameters<typeof createDiscordProviderInteractionSurface>[0];

const spec = (name: string): NativeCommandSpec => ({ name, description: name, acceptsArgs: false });
const names = (specs: readonly { name: string }[]) => specs.map(({ name }) => name);
const skill = (name: string) => ({ name, skillName: name, description: name });
const paddingSkills = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => skill(`${prefix}-${index}`));

function createInteractionHarness(
  commandSpecs: NativeCommandSpec[],
  channelRuntime?: InteractionParams["channelRuntime"],
  voiceEnabled = true,
) {
  const createNativeCommand = vi
    .spyOn(nativeCommandRuntime, "createDiscordNativeCommand")
    .mockImplementation(
      ({ command }) =>
        ({ name: command.name }) as ReturnType<
          typeof nativeCommandRuntime.createDiscordNativeCommand
        >,
    );
  const surface = createDiscordProviderInteractionSurface({
    cfg: {},
    discordConfig: {
      agentComponents: { enabled: false },
      execApprovals: { enabled: false },
    },
    accountId: "default",
    token: "token",
    commandSpecs,
    nativeEnabled: true,
    voiceEnabled,
    groupPolicy: "open",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
    voiceManagerRef: { current: null },
    guildEntries: undefined,
    allowFrom: [],
    dmPolicy: "open",
    runtime: createRuntimeSpies(),
    channelRuntime,
  });
  return { createNativeCommand, surface };
}

type SkillCommands = Awaited<ReturnType<typeof commandAuthNative.prepareSkillCommandsForAgents>>;

const skillCommands = [skill("skill-only"), skill("extra-skill")];

async function createResolverHarness(
  options: {
    pluginCommandSpecs?: NativeCommandSpec[];
    voiceEnabled?: boolean;
    skillCommands?: SkillCommands;
    nativeSkillsEnabled?: boolean;
  } = {},
) {
  const runtime = createRuntimeSpies();
  const configuredSkillCommands = options.skillCommands ?? skillCommands;
  vi.spyOn(commandAuthNative, "prepareSkillCommandsForAgents").mockResolvedValue(
    configuredSkillCommands,
  );
  const listSpecs = vi
    .spyOn(commandAuthNative, "listNativeCommandSpecsForConfig")
    .mockImplementation((_config, listOptions): NativeCommandSpec[] => [
      spec("built-in"),
      ...(listOptions?.skillCommands ?? []).map(({ name, description }) => ({
        name,
        description,
        acceptsArgs: true,
      })),
    ]);
  setActivePluginRegistry(createTestRegistry());
  for (const command of options.pluginCommandSpecs ?? []) {
    expect(
      registerPluginCommand(`test-${command.name}`, {
        ...command,
        channels: ["discord"],
        handler: async () => ({ text: "ok" }),
      }),
    ).toEqual({ ok: true });
  }

  return {
    ...runtime,
    listSpecs,
    resolved: await resolveDiscordProviderCommandSpecs({
      cfg: {},
      runtime,
      nativeEnabled: true,
      nativeSkillsEnabled: options.nativeSkillsEnabled ?? true,
      voiceEnabled: options.voiceEnabled ?? false,
    }),
  };
}

beforeEach(resetPluginRuntimeStateForTest);

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
});

it("reports only retained collisions after command overflow removes skills", async () => {
  const { resolved, ...harness } = await createResolverHarness({
    voiceEnabled: true,
    skillCommands: [...skillCommands, ...paddingSkills("overflow-skill", 96)],
    pluginCommandSpecs: [
      {
        ...spec("skill-only"),
        description: "Plugin skill alias",
        descriptionLocalizations: { de: "Plugin-Fertigkeitsalias" },
      },
      spec("plugin-unique"),
      spec("built-in"),
    ],
  });

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
  expect(harness.listSpecs).toHaveBeenCalledTimes(2);
  expect(harness.log).toHaveBeenCalledExactlyOnceWith(
    warn(
      "101 commands exceed the 100-command Discord limit; removing per-skill commands and keeping /skill.",
    ),
  );
});

it.each(["plugin", "skill"])("retains voice ownership against a %s named vc", async (source) => {
  const fromPlugin = source === "plugin";
  const vcSkillCommands = [skill("vc")];
  const { resolved, ...harness } = await createResolverHarness({
    voiceEnabled: true,
    nativeSkillsEnabled: !fromPlugin,
    pluginCommandSpecs: fromPlugin ? [spec("vc")] : [],
    skillCommands: fromPlugin ? undefined : vcSkillCommands,
  });

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
  const { createNativeCommand, surface } = createInteractionHarness(resolved.commandSpecs);
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
  const voiceSkill = { ...skill("voice"), description: "Skill voice" };
  const config: OpenClawConfig = { commands: { native: true, nativeSkills: true } };
  const primary = (commands: SkillCommands) =>
    commandAuthNative.listNativeCommandSpecsForConfig(config, {
      provider: "discord",
      skillCommands: commands,
    });
  const uniqueCount = (specs: NativeCommandSpec[]) =>
    new Set(names(specs).map(normalizeLowercaseStringOrEmpty).filter(Boolean)).size;
  const voiceSpecs = (specs: NativeCommandSpec[]) =>
    specs.filter((command) => normalizeLowercaseStringOrEmpty(command.name) === "voice");
  const cappedSkillCommands: SkillCommands = [
    voiceSkill,
    ...paddingSkills("cap-padding", 100 - uniqueCount(primary([voiceSkill]))),
  ];
  const rawPrimary = primary(cappedSkillCommands);
  const rawVoice = voiceSpecs(rawPrimary);
  expect(uniqueCount(rawPrimary)).toBe(100);
  expect(rawPrimary).toHaveLength(101);
  expect(rawVoice.map((command) => command.description)).toEqual([
    "Control text-to-speech (TTS).",
    "Skill voice",
  ]);
  const runtime = createRuntimeSpies();
  vi.spyOn(commandAuthNative, "prepareSkillCommandsForAgents").mockResolvedValue(
    cappedSkillCommands,
  );

  const resolved = await resolveDiscordProviderCommandSpecs({
    cfg: config,
    runtime,
    nativeEnabled: true,
    nativeSkillsEnabled: true,
    voiceEnabled: false,
  });

  expect(resolved.skillCommands).toEqual(cappedSkillCommands);
  expect(resolved.commandSpecs).toHaveLength(uniqueCount(rawPrimary));
  expect(voiceSpecs(resolved.commandSpecs)).toEqual([
    expect.objectContaining({ description: "Control text-to-speech (TTS)." }),
  ]);
  expect(runtime.log).not.toHaveBeenCalled();
});
it("binds native slash commands to the owning Gateway dispatcher", () => {
  const channelRuntime = createPluginRuntimeMock().channel;
  const { createNativeCommand, surface } = createInteractionHarness(
    [spec("normal")],
    channelRuntime,
    false,
  );

  expect(names(surface.commands)).toEqual(["normal"]);
  const commandOptions = createNativeCommand.mock.calls[0]?.[0];
  expect(commandOptions?.dispatchReplyFromConfig).toBe(
    channelRuntime.reply.dispatchReplyFromConfig,
  );
  expect(commandOptions?.buildContext).toBe(channelRuntime.inbound.buildContext);
});
