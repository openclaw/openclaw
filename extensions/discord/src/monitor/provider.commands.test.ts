import * as commandAuthNative from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/native-command-registry";
import { createPluginCommandRuntime } from "openclaw/plugin-sdk/plugin-command-runtime";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../../test-support/runtime-spies.js";
import { discordSetupPlugin } from "../channel.setup.js";
import { DISCORD_VOICE_COMMAND_SPEC } from "../voice/command.js";
import { resolveDiscordProviderCommandSpecs } from "./provider.commands.js";

const spec = (name: string): NativeCommandSpec => ({ name, description: name, acceptsArgs: false });
const names = (specs: readonly { name: string }[]) => specs.map(({ name }) => name);
const skill = (name: string) => ({ name, skillName: name, description: name });
const paddingSkills = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => skill(`${prefix}-${index}`));

type SkillCommands = Awaited<ReturnType<typeof commandAuthNative.prepareSkillCommandsForAgents>>;

const skillCommands = [skill("skill-only"), skill("extra-skill")];

async function createResolverHarness(
  options: {
    pluginCommandSpecs?: (NativeCommandSpec & { nativeNames?: Record<string, string> })[];
    channels?: string[];
    voiceEnabled?: boolean;
    skillCommands?: SkillCommands;
    nativeSkillsEnabled?: boolean;
  } = {},
) {
  const runtime = createRuntimeSpies();
  vi.spyOn(commandAuthNative, "prepareSkillCommandsForAgents").mockResolvedValue(
    options.skillCommands ?? skillCommands,
  );
  vi.spyOn(commandAuthNative, "listNativeCommandSpecsForConfig").mockImplementation(
    (_config, listOptions): NativeCommandSpec[] => [
      spec("built-in"),
      ...(listOptions?.skillCommands ?? []).map(({ name, description }) => ({
        name,
        description,
        acceptsArgs: true,
      })),
    ],
  );
  setActivePluginRegistry(createTestRegistry());
  for (const command of options.pluginCommandSpecs ?? []) {
    registerPluginCommand(`test-${command.name}`, {
      ...command,
      channels: options.channels ?? ["discord"],
      handler: async () => ({ text: command.name }),
    });
  }

  return {
    ...runtime,
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
    pluginCommandSpecs: [spec("skill-only"), spec("plugin-unique"), spec("built-in")],
  });

  expect(names(resolved.commandSpecs)).toEqual(["built-in", "vc", "skill-only", "plugin-unique"]);
  expect(harness.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('"/built-in" duplicates'),
  );
  expect(harness.log).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("removing per-skill commands"),
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
      expect.stringContaining('"/vc" duplicates'),
    );
    return;
  }
  expect(harness.error).not.toHaveBeenCalled();
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

  expect(resolved.commandSpecs).toHaveLength(100);
  expect(voiceSpecs(resolved.commandSpecs)).toEqual([
    expect.objectContaining({ description: "Control text-to-speech (TTS)." }),
  ]);
  expect(runtime.log).not.toHaveBeenCalled();
});

it("keeps the 32-character boundary and later valid commands before cap planning", async () => {
  const boundary = "a".repeat(32);
  const { resolved, ...harness } = await createResolverHarness({
    skillCommands: paddingSkills("skill", 97),
    pluginCommandSpecs: [spec(boundary), spec("b".repeat(33)), spec("LaterValid")],
  });

  expect(names(resolved.commandSpecs)).toEqual([
    "built-in",
    ...paddingSkills("skill", 97).map(({ name }) => name),
    boundary,
    "latervalid",
  ]);
  expect(harness.log).not.toHaveBeenCalled();
  expect(harness.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("exceeds the 32-character name limit"),
  );
});

it("normalizes Discord aliases without changing Slack spelling or plugin dispatch", async () => {
  const {
    resolved: { commandSpecs },
    ...runtime
  } = await createResolverHarness({
    nativeSkillsEnabled: false,
    channels: ["discord", "slack"],
    pluginCommandSpecs: [
      { ...spec("p".repeat(40)), nativeNames: { discord: "MiXeDAlias", slack: "SlackAlias" } },
      { ...spec("shadow"), nativeNames: { discord: "BuIlT-In" } },
    ],
  });
  expect(names(commandSpecs)).toEqual(["built-in", "mixedalias"]);
  expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('"/built-in" duplicates'),
  );
  expect(createPluginCommandRuntime().listNativeCandidates("slack")[0]?.name).toBe("SlackAlias");
  const candidate = commandSpecs[1]!;
  if (!("prepareDispatch" in candidate)) {
    throw new Error("Expected a plugin candidate");
  }
  const dispatch = candidate.prepareDispatch();
  if (dispatch.kind !== "plugin") {
    throw new Error("Expected the original plugin dispatch");
  }
  await expect(
    dispatch.execute({
      channel: "discord",
      isAuthorizedSender: true,
      commandBody: "/mixedalias",
      config: {},
    }),
  ).resolves.toEqual({ text: "p".repeat(40) });
});
