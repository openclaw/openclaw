import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let clearPluginCommands: typeof import("../../../src/plugins/commands.js").clearPluginCommands;
let registerPluginCommand: typeof import("../../../src/plugins/commands.js").registerPluginCommand;
let createCommandBot: typeof import("./bot-native-commands.menu-test-support.js").createCommandBot;
let createNativeCommandTestParams: typeof import("./bot-native-commands.menu-test-support.js").createNativeCommandTestParams;
let createPrivateCommandContext: typeof import("./bot-native-commands.menu-test-support.js").createPrivateCommandContext;
let waitForRegisteredCommands: typeof import("./bot-native-commands.menu-test-support.js").waitForRegisteredCommands;

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

async function registerPairMenu(params: {
  bot: ReturnType<typeof createCommandBot>["bot"];
  setMyCommands: ReturnType<typeof createCommandBot>["setMyCommands"];
  nativeNames?: { telegram?: string; discord?: string };
}) {
  registerPairPluginCommand({
    ...(params.nativeNames ? { nativeNames: params.nativeNames } : {}),
  });

  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({}),
    bot: params.bot,
  });

  return await waitForRegisteredCommands(params.setMyCommands);
}

describe("registerTelegramNativeCommands real plugin registry", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./bot/delivery.js", () => ({
      deliverReplies: deliveryMocks.deliverReplies,
    }));
    vi.doMock("./bot/delivery.replies.js", () => ({
      deliverReplies: deliveryMocks.deliverReplies,
    }));
    ({ clearPluginCommands, registerPluginCommand } =
      await import("../../../src/plugins/commands.js"));
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
    ({
      createCommandBot,
      createNativeCommandTestParams,
      createPrivateCommandContext,
      waitForRegisteredCommands,
    } = await import("./bot-native-commands.menu-test-support.js"));
  });

  beforeEach(() => {
    clearPluginCommands();
    deliveryMocks.deliverReplies.mockClear();
    deliveryMocks.deliverReplies.mockResolvedValue({ delivered: true });
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("registers and executes plugin commands through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    const registeredCommands = await registerPairMenu({ bot, setMyCommands });
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now" }));

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("round-trips Telegram native aliases through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    const registeredCommands = await registerPairMenu({
      bot,
      setMyCommands,
      nativeNames: {
        telegram: "pair_device",
        discord: "pairdiscord",
      },
    });
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair_device", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair_device");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now", messageId: 2 }));

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("keeps real plugin command handlers available when native menu registration is disabled", () => {
    const { bot, commandHandlers, setMyCommands } = createCommandBot();

    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}, { accountId: "default" }),
      bot,
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();
    expect(commandHandlers.has("pair")).toBe(true);
  });

  it("allows requireAuth:false plugin commands for unauthorized senders through the real registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    registerPairPluginCommand();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({
        commands: { allowFrom: { telegram: ["999"] } } as OpenClawConfig["commands"],
      }),
      bot,
      allowFrom: ["999"],
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.(
      createPrivateCommandContext({
        match: "now",
        messageId: 10,
        date: 123456,
        userId: 111,
        username: "nope",
      }),
    );

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
