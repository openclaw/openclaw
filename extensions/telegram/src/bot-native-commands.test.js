import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_DIR } from "../../../src/config/paths.js";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "../../../src/config/telegram-custom-commands.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
const { listSkillCommandsForAgents } = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => [])
}));
const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" }))
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true }))
}));
vi.mock("../../../src/auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listSkillCommandsForAgents
  };
});
vi.mock("../../../src/plugins/commands.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies
}));
describe("registerTelegramNativeCommands", () => {
  async function waitForRegisteredCommands(setMyCommands) {
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });
    return setMyCommands.mock.calls[0]?.[0];
  }
  beforeEach(() => {
    listSkillCommandsForAgents.mockClear();
    listSkillCommandsForAgents.mockReturnValue([]);
    pluginCommandMocks.getPluginCommandSpecs.mockClear();
    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([]);
    pluginCommandMocks.matchPluginCommand.mockClear();
    pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
    pluginCommandMocks.executePluginCommand.mockClear();
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" });
    deliveryMocks.deliverReplies.mockClear();
    deliveryMocks.deliverReplies.mockResolvedValue({ delivered: true });
  });
  const buildParams = (cfg, accountId = "default") => ({
    bot: {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(void 0),
        sendMessage: vi.fn().mockResolvedValue(void 0)
      },
      command: vi.fn()
    },
    cfg,
    runtime: {},
    accountId,
    telegramCfg: {},
    allowFrom: [],
    groupAllowFrom: [],
    replyToMode: "off",
    textLimit: 4e3,
    useAccessGroups: false,
    nativeEnabled: true,
    nativeSkillsEnabled: true,
    nativeDisabledExplicit: false,
    resolveGroupPolicy: () => ({
      allowlistEnabled: false,
      allowed: true
    }),
    resolveTelegramGroupConfig: () => ({
      groupConfig: void 0,
      topicConfig: void 0
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" }
  });
  it("scopes skill commands when account binding exists", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }]
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" }
        }
      ]
    };
    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));
    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"]
    });
  });
  it("scopes skill commands to default agent without a matching binding (#15599)", () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }]
      }
    };
    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));
    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["main"]
    });
  });
  it("truncates Telegram command registration to 100 commands", async () => {
    const cfg = {
      commands: { native: false }
    };
    const customCommands = Array.from({ length: 120 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index}`
    }));
    const setMyCommands = vi.fn().mockResolvedValue(void 0);
    const runtimeLog = vi.fn();
    registerTelegramNativeCommands({
      ...buildParams(cfg),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(void 0)
        },
        command: vi.fn()
      },
      runtime: { log: runtimeLog },
      telegramCfg: { customCommands },
      nativeEnabled: false,
      nativeSkillsEnabled: false
    });
    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(100);
    expect(registeredCommands).toEqual(customCommands.slice(0, 100));
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram limits bots to 100 commands. 120 configured; registering first 100. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands."
    );
  });
  it("normalizes hyphenated native command names for Telegram registration", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(void 0);
    const command = vi.fn();
    registerTelegramNativeCommands({
      ...buildParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(void 0)
        },
        command
      }
    });
    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.some((entry) => entry.command === "export_session")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "export-session")).toBe(false);
    const registeredHandlers = command.mock.calls.map(([name]) => name);
    expect(registeredHandlers).toContain("export_session");
    expect(registeredHandlers).not.toContain("export-session");
  });
  it("registers only Telegram-safe command names across native, custom, and plugin sources", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(void 0);
    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      { name: "plugin-status", description: "Plugin status" },
      { name: "plugin@bad", description: "Bad plugin command" }
    ]);
    registerTelegramNativeCommands({
      ...buildParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(void 0)
        },
        command: vi.fn()
      },
      telegramCfg: {
        customCommands: [
          { command: "custom-backup", description: "Custom backup" },
          { command: "custom!bad", description: "Bad custom command" }
        ]
      }
    });
    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.length).toBeGreaterThan(0);
    for (const entry of registeredCommands) {
      expect(entry.command.includes("-")).toBe(false);
      expect(TELEGRAM_COMMAND_NAME_PATTERN.test(entry.command)).toBe(true);
    }
    expect(registeredCommands.some((entry) => entry.command === "export_session")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "custom_backup")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "plugin_status")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "plugin-status")).toBe(false);
    expect(registeredCommands.some((entry) => entry.command === "custom-bad")).toBe(false);
  });
  it("passes agent-scoped media roots for plugin command replies with media", async () => {
    const commandHandlers = /* @__PURE__ */ new Map();
    const sendMessage = vi.fn().mockResolvedValue(void 0);
    const cfg = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }]
      },
      bindings: [{ agentId: "work", match: { channel: "telegram", accountId: "default" } }]
    };
    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "plug",
        description: "Plugin command"
      }
    ]);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "plug", requireAuth: false },
      args: void 0
    });
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "with media",
      mediaUrl: "/tmp/workspace-work/render.png"
    });
    registerTelegramNativeCommands({
      ...buildParams(cfg),
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(void 0),
          sendMessage
        },
        command: vi.fn((name, cb) => {
          commandHandlers.set(name, cb);
        })
      }
    });
    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.({
      match: "",
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1e3),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" }
      }
    });
    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")])
      })
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });
});
