import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import {
  createNativeCommandTestParams,
  type NativeCommandTestParams,
} from "./bot-native-commands.fixture-test-support.js";

type NativeCommandsModule = typeof import("./bot-native-commands.js");

type GetPluginCommandSpecsFn =
  typeof import("openclaw/plugin-sdk/plugin-runtime").getPluginCommandSpecs;
type MatchPluginCommandFn = typeof import("openclaw/plugin-sdk/plugin-runtime").matchPluginCommand;
type ExecutePluginCommandFn =
  typeof import("openclaw/plugin-sdk/plugin-runtime").executePluginCommand;

type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;

let registerTelegramNativeCommands: NativeCommandsModule["registerTelegramNativeCommands"];

const pluginMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn<GetPluginCommandSpecsFn>(() => []),
  matchPluginCommand: vi.fn<MatchPluginCommandFn>(() => null),
  executePluginCommand: vi.fn<ExecutePluginCommandFn>(async () => ({ text: "ok" })),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<DeliverRepliesFn>(async () => ({ delivered: true })),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginCommandSpecs: pluginMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginMocks.matchPluginCommand,
  executePluginCommand: pluginMocks.executePluginCommand,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

function createHarness(params?: {
  cfg?: OpenClawConfig;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  nativeEnabled?: boolean;
}) {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();

  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({
      cfg: params?.cfg ?? ({} as OpenClawConfig),
      runtime: { log, error: vi.fn(), exit: vi.fn() } as NativeCommandTestParams["runtime"],
      telegramCfg: params?.telegramCfg ?? ({} as TelegramAccountConfig),
      allowFrom: params?.allowFrom ?? [],
      nativeEnabled: params?.nativeEnabled ?? true,
      nativeSkillsEnabled: false,
      bot: {
        api: {
          setMyCommands,
          sendMessage,
        },
        command: vi.fn((name: string, handler: (ctx: unknown) => Promise<void>) => {
          handlers[name] = handler;
        }),
      } as unknown as NativeCommandTestParams["bot"],
    }),
  });

  return { handlers, setMyCommands, log, bot: { api: { sendMessage } } };
}

describe("registerTelegramNativeCommands (plugin auth)", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ registerTelegramNativeCommands } = await import("./bot-native-commands.js"));
    pluginMocks.getPluginCommandSpecs.mockReset().mockReturnValue([]);
    pluginMocks.matchPluginCommand.mockReset().mockReturnValue(null);
    pluginMocks.executePluginCommand.mockReset().mockResolvedValue({ text: "ok" });
    deliveryMocks.deliverReplies.mockReset().mockResolvedValue({ delivered: true });
  });

  it("does not register plugin commands in menu when native=false but keeps handlers available", () => {
    const specs = Array.from({ length: 101 }, (_, i) => ({
      name: `cmd_${i}`,
      description: `Command ${i}`,
      acceptsArgs: false,
    }));
    pluginMocks.getPluginCommandSpecs.mockReturnValue(specs as never);

    const { handlers, setMyCommands, log } = createHarness({
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

    pluginMocks.getPluginCommandSpecs.mockReturnValue([
      { name: "plugin", description: "Plugin command", acceptsArgs: false },
    ] as never);
    pluginMocks.matchPluginCommand.mockReturnValue({ command, args: undefined } as never);
    pluginMocks.executePluginCommand.mockResolvedValue({ text: "ok" } as never);

    const { handlers, bot } = createHarness({
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

    expect(pluginMocks.matchPluginCommand).toHaveBeenCalled();
    expect(pluginMocks.executePluginCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        isAuthorizedSender: false,
      }),
    );
    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "ok" }],
      }),
    );
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});
