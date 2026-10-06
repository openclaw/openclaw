import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
// Telegram tests cover bot native commands.registry plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let createCommandBot: typeof import("./bot-native-commands.menu-test-support.js").createCommandBot;
let createNativeCommandTestParams: typeof import("./bot-native-commands.menu-test-support.js").createNativeCommandTestParams;
let createPrivateCommandContext: typeof import("./bot-native-commands.menu-test-support.js").createPrivateCommandContext;
let deliverReplies: typeof import("./bot-native-commands.menu-test-support.js").deliverReplies;
let resetNativeCommandMenuMocks: typeof import("./bot-native-commands.menu-test-support.js").resetNativeCommandMenuMocks;
let waitForRegisteredCommands: typeof import("./bot-native-commands.menu-test-support.js").waitForRegisteredCommands;

function createTelegramPluginRegistry() {
  const registry = createEmptyPluginRegistry();
  registry.channels.push({
    pluginId: "telegram",
    source: "test",
    plugin: {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "test stub.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      commands: {
        nativeCommandsAutoEnabled: true,
      },
    },
  } as never);
  registry.channelSetups.push({
    pluginId: "telegram",
    source: "test",
    enabled: true,
    plugin: {
      id: "telegram",
    },
  } as never);
  return registry;
}

let activePluginRegistry: ReturnType<typeof createTelegramPluginRegistry>;

function registerPairPluginCommand(params?: {
  nativeNames?: { telegram?: string; discord?: string };
}) {
  expect(
    registerPluginCommand("demo-plugin", {
      name: "pair",
      ...(params?.nativeNames ? { nativeNames: params.nativeNames } : {}),
      description: "Pair device",
      acceptsArgs: true,
      requireAuth: false,
      handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
    }),
  ).toEqual({ ok: true });
}

function requireCommandHandler(
  commandHandlers: ReturnType<typeof createCommandBot>["commandHandlers"],
  commandName: string,
) {
  const handler = commandHandlers.get(commandName);
  if (!handler) {
    throw new Error(`expected ${commandName} command handler`);
  }
  return handler;
}

function expectLastDeliveredReplyText(text: string): void {
  const calls = deliverReplies.mock.calls as unknown[][];
  const payload = calls.at(-1)?.[0] as { replies?: Array<{ text?: string }> } | undefined;
  expect(payload?.replies?.map((reply) => reply.text)).toEqual([text]);
}

describe("registerTelegramNativeCommands real plugin registry", () => {
  beforeAll(async () => {
    resetPluginRuntimeStateForTest();
    activePluginRegistry = createTelegramPluginRegistry();
    setActivePluginRegistry(activePluginRegistry as never);
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
    ({
      createCommandBot,
      createNativeCommandTestParams,
      createPrivateCommandContext,
      deliverReplies,
      resetNativeCommandMenuMocks,
      waitForRegisteredCommands,
    } = await import("./bot-native-commands.menu-test-support.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    activePluginRegistry = createTelegramPluginRegistry();
    setActivePluginRegistry(activePluginRegistry as never);
    clearPluginCommands();
    resetNativeCommandMenuMocks();
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("normalizes composed menus without letting custom entries replace native or plugin owners", async () => {
    const { bot, commandHandlers, setMyCommands } = createCommandBot();
    registerPairPluginCommand({ nativeNames: { telegram: "Pair-Device" } });
    const longestName = "p".repeat(32);
    const oversizedName = `${longestName}x`;
    for (const name of [longestName, oversizedName]) {
      expect(
        registerPluginCommand(`plugin-${name}`, {
          name,
          description: "Plugin command",
          requireAuth: false,
          handler: async () => ({ text: "Length boundary accepted" }),
        }),
      ).toEqual({ ok: true });
    }

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(
        {},
        {
          telegramCfg: {
            customCommands: [
              { command: "/Custom-Backup", description: "Backup" },
              { command: "/Pair-Device", description: "Configured pair menu" },
              { command: "/Export-Session", description: "Custom export must lose" },
              { command: "custom!bad", description: "Invalid punctuation" },
              { command: "c".repeat(33), description: "Oversized custom command" },
            ],
          },
        },
      ),
      bot,
    });

    const registered = await waitForRegisteredCommands(setMyCommands);
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

    await requireCommandHandler(
      commandHandlers,
      "pair_device",
    )(createPrivateCommandContext({ match: "now" }));
    expectLastDeliveredReplyText("paired:now");
    await requireCommandHandler(commandHandlers, longestName)(createPrivateCommandContext());
    expectLastDeliveredReplyText("Length boundary accepted");
  });

  it.each([
    ["transformed-first", ["zeta", "foo-bar", "foo_bar", "alpha"]],
    ["exact-first", ["alpha", "foo_bar", "foo-bar", "zeta"]],
  ] as const)("executes the exact normalized winner with %s discovery", async (_label, names) => {
    const handlers = new Map<string, ReturnType<typeof vi.fn>>();
    for (const name of names) {
      const handler = vi.fn(async () => ({
        text: name === "foo_bar" ? "Exact owner ran" : "Other owner ran",
      }));
      handlers.set(name, handler);
      expect(
        registerPluginCommand(`plugin-${name}`, {
          name,
          description: name,
          descriptionLocalizations: { ko: name === "foo_bar" ? "정확함" : "다른 명령" },
          channels: ["telegram"],
          requireAuth: false,
          handler,
        }),
      ).toEqual({ ok: true });
    }
    const { bot, commandHandlers, setMyCommands } = createCommandBot();
    registerTelegramNativeCommands({ ...createNativeCommandTestParams({}), bot });
    const registered = await waitForRegisteredCommands(setMyCommands);
    expect(registered.filter((command) => command.command === "foo_bar")).toEqual([
      { command: "foo_bar", description: "foo_bar", descriptionLocalizations: { ko: "정확함" } },
    ]);
    const namesInMenu = registered.map(({ command }) => command);
    expect(namesInMenu.indexOf("alpha")).toBeGreaterThan(namesInMenu.indexOf("status"));
    expect(namesInMenu.indexOf("foo_bar")).toBeGreaterThan(namesInMenu.indexOf("alpha"));
    expect(namesInMenu.indexOf("zeta")).toBeGreaterThan(namesInMenu.indexOf("foo_bar"));
    expect(namesInMenu.indexOf("side")).toBeGreaterThan(namesInMenu.indexOf("zeta"));

    await requireCommandHandler(commandHandlers, "foo_bar")(createPrivateCommandContext());

    expectLastDeliveredReplyText("Exact owner ran");
    expect(handlers.get("foo_bar")).toHaveBeenCalledOnce();
    expect(handlers.get("foo-bar")).not.toHaveBeenCalled();
  });

  it.each([
    ["telegram-first", ["foo-bar", "foo_bar"]],
    ["discord-first", ["foo_bar", "foo-bar"]],
  ] as const)("ignores a cross-channel exact shadow with %s discovery", async (_label, names) => {
    const telegramHandler = vi.fn(async () => ({ text: "telegram-owner" }));
    const discordHandler = vi.fn(async () => ({ text: "discord-owner" }));
    for (const name of names) {
      const telegram = name === "foo-bar";
      expect(
        registerPluginCommand(telegram ? "telegram-owner" : "discord-owner", {
          name,
          description: name,
          channels: [telegram ? "telegram" : "discord"],
          requireAuth: false,
          handler: telegram ? telegramHandler : discordHandler,
        }),
      ).toEqual({ ok: true });
    }
    const { bot, commandHandlers, setMyCommands } = createCommandBot();
    registerTelegramNativeCommands({ ...createNativeCommandTestParams({}), bot });
    await waitForRegisteredCommands(setMyCommands);

    await requireCommandHandler(commandHandlers, "foo_bar")(createPrivateCommandContext());

    expectLastDeliveredReplyText("telegram-owner");
    expect(telegramHandler).toHaveBeenCalledOnce();
    expect(discordHandler).not.toHaveBeenCalled();
  });

  it.each([
    { command: "pair", channels: undefined, retained: true },
    { command: "discord-only", channels: ["discord"], retained: false },
  ])(
    "registers only supported plugin handlers when native menu display is disabled: $command",
    async ({ command, channels, retained }) => {
      const { bot, commandHandlers, setMyCommands } = createCommandBot();

      expect(
        registerPluginCommand("demo-plugin", {
          name: command,
          description: `${command} command`,
          channels,
          requireAuth: false,
          handler: async () => ({ text: "ok" }),
        }),
      ).toEqual({ ok: true });

      registerTelegramNativeCommands({
        ...createNativeCommandTestParams(
          {},
          {
            accountId: "default",
            telegramCfg: {
              customCommands: [
                { command: "/Custom-Backup", description: "Backup" },
                { command: "/Login", description: "Custom login must lose" },
              ],
            },
          },
        ),
        bot,
        nativeEnabled: false,
      });

      expect(await waitForRegisteredCommands(setMyCommands)).toEqual([
        { command: "custom_backup", description: "Backup" },
      ]);
      expect(commandHandlers.has(command.replaceAll("-", "_"))).toBe(retained);
      expect(commandHandlers.has("login")).toBe(false);
      if (retained) {
        await requireCommandHandler(commandHandlers, command)(createPrivateCommandContext());
        expectLastDeliveredReplyText("ok");
      }
    },
  );

  it("allows requireAuth:false plugin commands for unauthorized senders through the real registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({
        commands: { allowFrom: { telegram: ["999"] } } as OpenClawConfig["commands"],
      }),
      bot,
      opts: { token: "token", allowFrom: ["999"] },
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();

    const handler = requireCommandHandler(commandHandlers, "pair");

    await handler(
      createPrivateCommandContext({
        match: "now",
        messageId: 10,
        date: 123456,
        userId: 111,
        username: "nope",
      }),
    );

    expectLastDeliveredReplyText("paired:now");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
