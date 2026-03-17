import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { STATE_DIR } from "../../../src/config/paths.js";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "../../../src/config/telegram-custom-commands.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  listSkillCommandsForAgents,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";

const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
vi.mock("../../../src/plugins/commands.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));

describe("registerTelegramNativeCommands", () => {
  beforeEach(() => {
    resetNativeCommandMenuMocks();
    pluginCommandMocks.getPluginCommandSpecs.mockClear();
    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([]);
    pluginCommandMocks.matchPluginCommand.mockClear();
    pluginCommandMocks.matchPluginCommand.mockReturnValue(null);
    pluginCommandMocks.executePluginCommand.mockClear();
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" });
  });

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { accountId: "bot-a" }));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("scopes skill commands to default agent without a matching binding (#15599)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(createNativeCommandTestParams(cfg, { accountId: "bot-a" }));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["main"],
    });
  });

  it("truncates Telegram command registration to 100 commands", async () => {
    const cfg: OpenClawConfig = {
      commands: { native: false },
    };
    const customCommands = Array.from({ length: 120 }, (_, index) => ({
      command: `cmd_${index}`,
      description: `Command ${index}`,
    }));
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const runtimeLog = vi.fn();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(cfg),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      runtime: { log: runtimeLog } as unknown as RuntimeEnv,
      telegramCfg: { customCommands } as TelegramAccountConfig,
      nativeEnabled: false,
      nativeSkillsEnabled: false,
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toHaveLength(100);
    expect(registeredCommands).toEqual(customCommands.slice(0, 100));
    expect(runtimeLog).toHaveBeenCalledWith(
      "Telegram limits bots to 100 commands. 120 configured; registering first 100. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.",
    );
  });

  it("normalizes hyphenated native command names for Telegram registration", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const command = vi.fn();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command,
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands.some((entry) => entry.command === "export_session")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "export-session")).toBe(false);

    const registeredHandlers = command.mock.calls.map(([name]) => name);
    expect(registeredHandlers).toContain("export_session");
    expect(registeredHandlers).not.toContain("export-session");
  });

  it("registers only Telegram-safe command names across native, custom, and plugin sources", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      { name: "plugin-status", description: "Plugin status" },
      { name: "plugin@bad", description: "Bad plugin command" },
    ] as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      telegramCfg: {
        customCommands: [
          { command: "custom-backup", description: "Custom backup" },
          { command: "custom!bad", description: "Bad custom command" },
        ],
      } as TelegramAccountConfig,
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
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "work" }],
      },
      bindings: [{ agentId: "work", match: { channel: "telegram", accountId: "default" } }],
    };

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "plug",
        description: "Plugin command",
      },
    ] as never);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "plug", requireAuth: false },
      args: undefined,
    } as never);
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "with media",
      mediaUrl: "/tmp/workspace-work/render.png",
    } as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(cfg, {
        bot: {
          api: {
            setMyCommands: vi.fn().mockResolvedValue(undefined),
            sendMessage,
          },
          command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
            commandHandlers.set(name, cb);
          }),
        } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      }),
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.(createPrivateCommandContext());

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("sends plugin command error replies silently when silentErrorReplies is enabled", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "plug",
        description: "Plugin command",
      },
    ] as never);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "plug", requireAuth: false },
      args: undefined,
    } as never);
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "plugin failed",
      isError: true,
    } as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(
        {},
        {
          bot: {
            api: {
              setMyCommands: vi.fn().mockResolvedValue(undefined),
              sendMessage: vi.fn().mockResolvedValue(undefined),
            },
            command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
              commandHandlers.set(name, cb);
            }),
          } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
        },
      ),
      telegramCfg: { silentErrorReplies: true } as TelegramAccountConfig,
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.(createPrivateCommandContext());

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        silent: true,
        replies: [expect.objectContaining({ isError: true })],
      }),
    );
  });
});
