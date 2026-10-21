import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  const unauthenticated = { requireAuth: false, ...command };
  expect(registerPluginCommand(pluginId, unauthenticated)).toEqual({ ok: true });
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
    expect(names.indexOf("status")).toBeGreaterThan(names.indexOf("pair_device"));
    expect(names.indexOf(longestName)).toBeGreaterThan(names.indexOf("status"));
    expect(names.indexOf("side")).toBeGreaterThan(names.indexOf(longestName));
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
    ["same-channel transformed-first", ["zeta", "foo-bar", "foo_bar", "alpha"], true],
    ["same-channel exact-first", ["alpha", "foo_bar", "foo-bar", "zeta"], true],
    ["cross-channel telegram-first", ["foo-bar", "foo_bar"], false],
    ["cross-channel discord-first", ["foo_bar", "foo-bar"], false],
  ] as const)(
    "executes the normalized owner with %s discovery",
    async (_label, names, sameChannel) => {
      const handlers = new Map<string, ReturnType<typeof vi.fn>>();
      const owner = sameChannel ? "foo_bar" : "foo-bar";
      const reply = sameChannel ? "Exact owner ran" : "telegram-owner";
      for (const name of names) {
        const handler = vi.fn(async () => ({
          text: name === owner ? reply : sameChannel ? "Other owner ran" : "discord-owner",
        }));
        handlers.set(name, handler);
        registerCommand(
          sameChannel ? `plugin-${name}` : name === owner ? "telegram-owner" : "discord-owner",
          {
            name,
            description: name,
            ...(sameChannel
              ? { descriptionLocalizations: { ko: name === "foo_bar" ? "정확함" : "다른 명령" } }
              : {}),
            channels: [sameChannel || name === owner ? "telegram" : "discord"],
            handler,
          },
        );
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
        const namesInMenu = registered.map(({ command }) => command);
        expect(namesInMenu.indexOf("alpha")).toBeGreaterThan(namesInMenu.indexOf("status"));
        expect(namesInMenu.indexOf("foo_bar")).toBeGreaterThan(namesInMenu.indexOf("alpha"));
        expect(namesInMenu.indexOf("zeta")).toBeGreaterThan(namesInMenu.indexOf("foo_bar"));
        expect(namesInMenu.indexOf("side")).toBeGreaterThan(namesInMenu.indexOf("zeta"));
      }
      await expectCommandReply(commandHandlers, "foo_bar", reply);
      expect(handlers.get(owner)).toHaveBeenCalledOnce();
      expect(handlers.get(sameChannel ? "foo-bar" : "foo_bar")).not.toHaveBeenCalled();
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
      messageId: 10,
      date: 123456,
      userId: 111,
      username: "nope",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
