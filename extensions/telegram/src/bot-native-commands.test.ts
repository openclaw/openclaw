import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { TELEGRAM_COMMAND_NAME_PATTERN } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { STATE_DIR } from "openclaw/plugin-sdk/state-paths";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginCommandMocks, resetPluginCommandMocks } from "./test-support/plugin-command.js";

let registerTelegramNativeCommands: typeof import("./bot-native-commands.js").registerTelegramNativeCommands;
let parseTelegramNativeCommandCallbackData: typeof import("./bot-native-commands.js").parseTelegramNativeCommandCallbackData;
import {
  createCommandBot,
  createNativeCommandTestParams,
  createPrivateCommandContext,
  deliverReplies,
  editMessageTelegram,
  listSkillCommandsForAgents,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";

describe("registerTelegramNativeCommands", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ registerTelegramNativeCommands, parseTelegramNativeCommandCallbackData } =
      await import("./bot-native-commands.js"));
  });

  beforeEach(() => {
    resetNativeCommandMenuMocks();
    resetPluginCommandMocks();
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

  it("prefixes native command menu callback data so callback handlers can preserve native routing", async () => {
    const { bot, commandHandlers, sendMessage } = createCommandBot();

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}, { bot }),
    });

    const handler = commandHandlers.get("fast");
    expect(handler).toBeTruthy();
    await handler?.(createPrivateCommandContext());

    const replyMarkup = sendMessage.mock.calls[0]?.[2]?.reply_markup as
      | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
      | undefined;
    const callbackData = replyMarkup?.inline_keyboard
      ?.flat()
      .map((button) => button.callback_data)
      .filter(Boolean);

    expect(callbackData).toEqual(["tgcmd:/fast status", "tgcmd:/fast on", "tgcmd:/fast off"]);
    expect(parseTelegramNativeCommandCallbackData("tgcmd:/fast status")).toBe("/fast status");
    expect(parseTelegramNativeCommandCallbackData("tgcmd:fast status")).toBeNull();
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

    const firstDeliverRepliesCall = deliverReplies.mock.calls.at(0) as [unknown] | undefined;
    expect(firstDeliverRepliesCall?.[0]).toEqual(
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([
          expect.stringMatching(/[\\/]\.openclaw[\\/]workspace-work$/),
        ]),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });

  it("shows immediate progress feedback for /lossless doctor apply and edits it in place on success", async () => {
    const { bot, commandHandlers, sendMessage } = createCommandBot();

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "lossless",
        nativeNames: { default: "lossless" },
        description: "Lossless Claw command",
      },
    ] as never);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "lcm", requireAuth: false },
      args: "doctor apply",
    } as never);
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "Lossless Claw Doctor Apply\n\nresult: repaired 8 summary(s) in place",
    } as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}, { bot }),
    });

    const handler = commandHandlers.get("lossless");
    expect(handler).toBeTruthy();
    await handler?.(
      createPrivateCommandContext({
        match: "doctor apply",
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Running `/lossless doctor apply`"),
      undefined,
    );
    expect(editMessageTelegram).toHaveBeenCalledWith(
      100,
      999,
      expect.stringContaining("Lossless Claw Doctor Apply"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("falls back to a normal reply when the progress result is not editable", async () => {
    const { bot, commandHandlers, sendMessage } = createCommandBot();

    pluginCommandMocks.getPluginCommandSpecs.mockReturnValue([
      {
        name: "lcm",
        nativeNames: { default: "lcm" },
        description: "Lossless Claw command",
      },
    ] as never);
    pluginCommandMocks.matchPluginCommand.mockReturnValue({
      command: { key: "lcm", requireAuth: false },
      args: "doctor apply",
    } as never);
    pluginCommandMocks.executePluginCommand.mockResolvedValue({
      text: "rich output",
      mediaUrl: "/tmp/render.png",
    } as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams({}, { bot }),
    });

    const handler = commandHandlers.get("lcm");
    expect(handler).toBeTruthy();
    await handler?.(
      createPrivateCommandContext({
        match: "doctor apply",
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Running `/lcm doctor apply`"),
      undefined,
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ mediaUrl: "/tmp/render.png" })],
      }),
    );
  });

  it("sends plugin command error replies silently when silentErrorReplies is enabled", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          silentErrorReplies: true,
        },
      },
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
      text: "plugin failed",
      isError: true,
    } as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(cfg, {
        bot: {
          api: {
            setMyCommands: vi.fn().mockResolvedValue(undefined),
            sendMessage: vi.fn().mockResolvedValue(undefined),
          },
          command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
            commandHandlers.set(name, cb);
          }),
        } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      }),
      telegramCfg: { silentErrorReplies: true } as TelegramAccountConfig,
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.(createPrivateCommandContext());

    const firstDeliverRepliesCall = deliverReplies.mock.calls.at(0) as [unknown] | undefined;
    expect(firstDeliverRepliesCall?.[0]).toEqual(
      expect.objectContaining({
        silent: true,
        replies: [expect.objectContaining({ isError: true })],
      }),
    );
  });

  it("forwards topic-scoped binding context to Telegram plugin commands", async () => {
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
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" } as never);

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
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.({
      match: "",
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        message_thread_id: 77,
        from: { id: 200, username: "bob" },
      },
    });

    expect(pluginCommandMocks.executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "default",
        from: "telegram:group:-1001234567890:topic:77",
        to: "telegram:-1001234567890",
        messageThreadId: 77,
      }),
    );
  });

  it("treats Telegram forum #General commands as topic 1 when Telegram omits topic metadata", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const getChat = vi.fn(async () => ({ id: -1001234567890, type: "supergroup", is_forum: true }));

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
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" } as never);

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(
        {},
        {
          bot: {
            api: {
              setMyCommands: vi.fn().mockResolvedValue(undefined),
              sendMessage: vi.fn().mockResolvedValue(undefined),
              getChat,
            },
            command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
              commandHandlers.set(name, cb);
            }),
          } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
        },
      ),
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.({
      match: "",
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
        },
        from: { id: 200, username: "bob" },
      },
    });

    expect(getChat).toHaveBeenCalledWith(-1001234567890);
    expect(pluginCommandMocks.executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        from: "telegram:group:-1001234567890:topic:1",
        to: "telegram:-1001234567890",
        messageThreadId: 1,
      }),
    );
  });

  it("forwards direct-message binding context to Telegram plugin commands", async () => {
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
    pluginCommandMocks.executePluginCommand.mockResolvedValue({ text: "ok" } as never);

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
    });

    const handler = commandHandlers.get("plug");
    expect(handler).toBeTruthy();
    await handler?.(createPrivateCommandContext({ chatId: 100, userId: 200 }));

    expect(pluginCommandMocks.executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "default",
        from: "telegram:100",
        to: "telegram:100",
        messageThreadId: undefined,
      }),
    );
  });
});
