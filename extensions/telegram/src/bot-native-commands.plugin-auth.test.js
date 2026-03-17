import { describe, expect, it, vi } from "vitest";
import {
  createNativeCommandsHarness,
  deliverReplies,
  executePluginCommand,
  getPluginCommandSpecs,
  matchPluginCommand
} from "./bot-native-commands.test-helpers.js";
const getPluginCommandSpecsMock = getPluginCommandSpecs;
const matchPluginCommandMock = matchPluginCommand;
const executePluginCommandMock = executePluginCommand;
describe("registerTelegramNativeCommands (plugin auth)", () => {
  it("does not register plugin commands in menu when native=false but keeps handlers available", () => {
    const specs = Array.from({ length: 101 }, (_, i) => ({
      name: `cmd_${i}`,
      description: `Command ${i}`,
      acceptsArgs: false
    }));
    getPluginCommandSpecsMock.mockReturnValue(specs);
    const { handlers, setMyCommands, log } = createNativeCommandsHarness({
      cfg: {},
      telegramCfg: {},
      nativeEnabled: false
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
      handler: vi.fn()
    };
    getPluginCommandSpecsMock.mockReturnValue([
      { name: "plugin", description: "Plugin command", acceptsArgs: false }
    ]);
    matchPluginCommandMock.mockReturnValue({ command, args: void 0 });
    executePluginCommandMock.mockResolvedValue({ text: "ok" });
    const { handlers, bot } = createNativeCommandsHarness({
      cfg: {},
      telegramCfg: {},
      allowFrom: ["999"],
      nativeEnabled: false
    });
    const ctx = {
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 111, username: "nope" },
        message_id: 10,
        date: 123456
      },
      match: ""
    };
    await handlers.plugin?.(ctx);
    expect(matchPluginCommand).toHaveBeenCalled();
    expect(executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false
      })
    );
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }]
      })
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
