import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let menu: typeof import("./bot-native-commands.menu-test-support.js");

function installRegistry() {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          id: "telegram",
          meta: {},
          config: {},
          commands: { nativeCommandsAutoEnabled: true },
        },
      },
    ]),
  );
}

function registerCommand(pluginId: string, command: Parameters<typeof registerPluginCommand>[1]) {
  expect(registerPluginCommand(pluginId, { requireAuth: false, ...command })).toEqual({ ok: true });
}

async function registerMenu(
  params: Parameters<typeof menu.createNativeCommandTestParams>[1] = {},
  cfg: OpenClawConfig = {},
) {
  const test = menu.createCommandBot();
  await registerTelegramNativeCommands({
    ...menu.createNativeCommandTestParams(cfg, params),
    bot: test.bot,
  });
  return test;
}

function registerPairPluginCommand(telegram?: string) {
  registerCommand("demo-plugin", {
    name: "pair",
    ...(telegram ? { nativeNames: { telegram } } : {}),
    description: "Pair device",
    acceptsArgs: true,
    handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
  });
}

async function expectCommandReply(
  commandHandlers: ReturnType<typeof menu.createCommandBot>["commandHandlers"],
  commandName: string,
  text: string,
  context?: Parameters<typeof menu.createPrivateCommandContext>[0],
) {
  const handler = commandHandlers.get(commandName);
  if (!handler) {
    throw new Error(`expected ${commandName} command handler`);
  }
  await handler(menu.createPrivateCommandContext(context));
  const calls = menu.deliverReplies.mock.calls as unknown[][];
  const payload = calls.at(-1)?.[0] as { replies?: Array<{ text?: string }> } | undefined;
  expect(payload?.replies?.map((reply) => reply.text)).toEqual([text]);
}

describe("registerTelegramNativeCommands real plugin registry", () => {
  beforeAll(async () => {
    installRegistry();
    menu = await import("./bot-native-commands.menu-test-support.js");
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    installRegistry();
    clearPluginCommands();
    menu.resetNativeCommandMenuMocks();
  });

  afterEach(clearPluginCommands);

  it("normalizes composed menus without letting custom entries replace native or plugin owners", async () => {
    registerPairPluginCommand("Pair-Device");
    const longestName = "p".repeat(32);
    const oversizedName = `${longestName}x`;
    for (const name of [longestName, oversizedName]) {
      registerCommand(`plugin-${name}`, {
        name,
        description: "Plugin command",
        handler: async () => ({ text: "Length boundary accepted" }),
      });
    }

    const { commandHandlers, setMyCommands } = await registerMenu({
      telegramCfg: {
        customCommands: [
          { command: "/Custom-Backup", description: "Backup" },
          { command: "/Pair-Device", description: "Configured pair menu" },
          { command: "/Export-Session", description: "Custom export must lose" },
          { command: "custom!bad", description: "Invalid punctuation" },
          { command: "c".repeat(33), description: "Oversized custom command" },
        ],
      },
    });

    const registered = await menu.waitForRegisteredCommands(setMyCommands);
    const names = registered.map(({ command }) => command);
    expect(registered.filter(({ command }) => command === "pair_device")).toEqual([
      { command: "pair_device", description: "Configured pair menu" },
    ]);
    expect(registered.filter(({ command }) => command === "export_session")).toEqual([
      expect.objectContaining({ description: expect.not.stringContaining("Custom export") }),
    ]);
    expect(names.slice(0, 2)).toEqual(["custom_backup", "pair_device"]);
    expect(
      names.filter((name) => ["pair_device", "status", longestName, "side"].includes(name)),
    ).toEqual(["pair_device", "status", longestName, "side"]);
    for (const invalid of ["custom!bad", "c".repeat(33), oversizedName]) {
      expect(names).not.toContain(invalid);
    }
    expect(commandHandlers.has("export_session")).toBe(true);
    expect(commandHandlers.has("export-session")).toBe(false);
    expect(commandHandlers.has(oversizedName)).toBe(false);

    await expectCommandReply(commandHandlers, "pair_device", "paired:now", { match: "now" });
    await expectCommandReply(commandHandlers, longestName, "Length boundary accepted");
  });

  it.each([
    ["same-channel transformed-first", ["foo-bar", "foo_bar"], true],
    ["cross-channel telegram-first", ["foo-bar", "foo_bar"], false],
  ] as const)(
    "executes the normalized owner with %s discovery",
    async (_label, names, sameChannel) => {
      const invoked: string[] = [];
      const owner = sameChannel ? "foo_bar" : "foo-bar";
      for (const name of names) {
        registerCommand(`plugin-${name}`, {
          name,
          description: name,
          descriptionLocalizations: sameChannel
            ? { ko: name === "foo_bar" ? "정확함" : "다른 명령" }
            : undefined,
          channels: [sameChannel || name === owner ? "telegram" : "discord"],
          handler: async () => {
            invoked.push(name);
            return { text: name };
          },
        });
      }
      const { commandHandlers, setMyCommands } = await registerMenu();
      const registered = await menu.waitForRegisteredCommands(setMyCommands);
      if (sameChannel) {
        expect(registered.filter((command) => command.command === "foo_bar")).toEqual([
          {
            command: "foo_bar",
            description: "foo_bar",
            descriptionLocalizations: { ko: "정확함" },
          },
        ]);
      }
      await expectCommandReply(commandHandlers, "foo_bar", owner);
      expect(invoked).toEqual([owner]);
    },
  );

  it.each([
    { command: "pair", channels: undefined, retained: true },
    { command: "discord-only", channels: ["discord"], retained: false },
  ])(
    "registers only supported plugin handlers when native menu display is disabled: $command",
    async ({ command, channels, retained }) => {
      registerCommand("demo-plugin", {
        name: command,
        description: `${command} command`,
        channels,
        handler: async () => ({ text: "ok" }),
      });

      const { commandHandlers, setMyCommands } = await registerMenu({
        accountId: "default",
        telegramCfg: {
          customCommands: [
            { command: "/Custom-Backup", description: "Backup" },
            { command: "/Login", description: "Custom login must lose" },
          ],
        },
        nativeEnabled: false,
      });

      expect(await menu.waitForRegisteredCommands(setMyCommands)).toEqual([
        { command: "custom_backup", description: "Backup" },
      ]);
      expect(commandHandlers.has(command.replaceAll("-", "_"))).toBe(retained);
      expect(commandHandlers.has("login")).toBe(false);
      if (retained) {
        await expectCommandReply(commandHandlers, command, "ok");
      }
    },
  );

  it("allows requireAuth:false plugin commands for unauthorized senders through the real registry", async () => {
    registerPairPluginCommand();
    const { commandHandlers, sendMessage, setMyCommands } = await registerMenu(
      {
        opts: { token: "token", allowFrom: ["999"] },
        nativeEnabled: false,
      },
      { commands: { allowFrom: { telegram: ["999"] } } as OpenClawConfig["commands"] },
    );

    expect(setMyCommands).not.toHaveBeenCalled();

    await expectCommandReply(commandHandlers, "pair", "paired:now", {
      match: "now",
      userId: 111,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
