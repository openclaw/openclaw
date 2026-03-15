import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import {
  createNativeCommandsHarness,
  deliverReplies,
  executePluginCommand,
  getPluginCommandSpecs,
  matchPluginCommand,
} from "./bot-native-commands.test-helpers.js";

type GetPluginCommandSpecsMock = {
  mockReturnValue: (
    value: ReturnType<typeof import("../../../src/plugins/commands.js").getPluginCommandSpecs>,
  ) => unknown;
};
type MatchPluginCommandMock = {
  mockReturnValue: (
    value: ReturnType<typeof import("../../../src/plugins/commands.js").matchPluginCommand>,
  ) => unknown;
};
type ExecutePluginCommandMock = {
  mockResolvedValue: (
    value: Awaited<
      ReturnType<typeof import("../../../src/plugins/commands.js").executePluginCommand>
    >,
  ) => unknown;
};

const getPluginCommandSpecsMock = getPluginCommandSpecs as unknown as GetPluginCommandSpecsMock;
const matchPluginCommandMock = matchPluginCommand as unknown as MatchPluginCommandMock;
const executePluginCommandMock = executePluginCommand as unknown as ExecutePluginCommandMock;

describe("registerTelegramNativeCommands (plugin auth)", () => {
  it("does not register plugin commands in menu when native=false but keeps handlers available", () => {
    const specs = Array.from({ length: 101 }, (_, i) => ({
      name: `cmd_${i}`,
      description: `Command ${i}`,
      acceptsArgs: false,
    }));
    getPluginCommandSpecsMock.mockReturnValue(specs);

    const { handlers, setMyCommands, log } = createNativeCommandsHarness({
      cfg: {} as OpenClawConfig,
      telegramCfg: {} as TelegramAccountConfig,
      nativeEnabled: false,
    });

    expect(setMyCommands).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("registering first 100"));
    expect(Object.keys(handlers)).toHaveLength(101);
  });

  it("allows requireAuth:false plugin command even when sender is unauthorized", async () => {
    const command = {
      name: "plugin",
      description: "Plugin command",
      pluginId: "test-plugin",
      requireAuth: false,
      handler: vi.fn(),
    } as const;

    getPluginCommandSpecsMock.mockReturnValue([
      { name: "plugin", description: "Plugin command", acceptsArgs: false },
    ]);
    matchPluginCommandMock.mockReturnValue({ command, args: undefined });
    executePluginCommandMock.mockResolvedValue({ text: "ok" });

    const { handlers, bot } = createNativeCommandsHarness({
      cfg: {} as OpenClawConfig,
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: ["999"],
      nativeEnabled: false,
    });

    const ctx = {
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "nope" },
        message_id: 10,
        date: 123456,
      },
      match: "",
    };

    await handlers.plugin?.(ctx);

    expect(matchPluginCommand).toHaveBeenCalled();
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false,
      }),
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }],
      }),
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
