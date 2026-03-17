import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../../src/plugins/commands.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";

describe("registerTelegramNativeCommands real plugin registry", () => {
  beforeEach(() => {
    clearPluginCommands();
    resetNativeCommandMenuMocks();
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("registers and executes plugin commands through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now" }));

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("round-trips Telegram native aliases through the real plugin registry", async () => {
    const { bot, commandHandlers, sendMessage, setMyCommands } = createCommandBot();

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        nativeNames: {
          telegram: "pair_device",
          discord: "pairdiscord",
        },
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair_device", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair_device");
    expect(handler).toBeTruthy();

    await handler?.(createPrivateCommandContext({ match: "now", messageId: 2 }));

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("keeps real plugin command handlers available when native menu registration is disabled", () => {
    const { bot, commandHandlers, setMyCommands } = createCommandBot();

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

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

    expect(
      registerPluginCommand("demo-plugin", {
        name: "pair",
        description: "Pair device",
        acceptsArgs: true,
        requireAuth: false,
        handler: async ({ args }) => ({ text: `paired:${args ?? ""}` }),
      }),
    ).toEqual({ ok: true });

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

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
