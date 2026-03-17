import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import { clearPluginCommands, registerPluginCommand } from "../../../src/plugins/commands.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const { listSkillCommandsForAgents } = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

vi.mock("../../../src/auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auto-reply/skill-commands.js")>();
  return {
    ...actual,
    listSkillCommandsForAgents,
  };
});

vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

describe("registerTelegramNativeCommands real plugin registry", () => {
  type RegisteredCommand = {
    command: string;
    description: string;
  };

  async function waitForRegisteredCommands(
    setMyCommands: ReturnType<typeof vi.fn>,
  ): Promise<RegisteredCommand[]> {
    await vi.waitFor(() => {
      expect(setMyCommands).toHaveBeenCalled();
    });
    return setMyCommands.mock.calls[0]?.[0] as RegisteredCommand[];
  }

  const buildParams = (cfg: OpenClawConfig, accountId = "default") =>
    ({
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      runtime: {} as RuntimeEnv,
      accountId,
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: [],
      groupAllowFrom: [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: false,
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      nativeDisabledExplicit: false,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ReturnType<
          Parameters<typeof registerTelegramNativeCommands>[0]["resolveGroupPolicy"]
        >,
      resolveTelegramGroupConfig: () => ({
        groupConfig: undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    }) satisfies Parameters<typeof registerTelegramNativeCommands>[0];

  beforeEach(() => {
    clearPluginCommands();
    deliveryMocks.deliverReplies.mockClear();
    deliveryMocks.deliverReplies.mockResolvedValue({ delivered: true });
    listSkillCommandsForAgents.mockClear();
    listSkillCommandsForAgents.mockReturnValue([]);
  });

  afterEach(() => {
    clearPluginCommands();
  });

  it("registers and executes plugin commands through the real plugin registry", async () => {
    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

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
      ...buildParams({}),
      bot: {
        api: {
          setMyCommands,
          sendMessage,
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);
    expect(registeredCommands).toEqual(
      expect.arrayContaining([{ command: "pair", description: "Pair device" }]),
    );

    const handler = commandHandlers.get("pair");
    expect(handler).toBeTruthy();

    await handler?.({
      match: "now",
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "alice" },
      },
    });

    expect(deliveryMocks.deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "paired:now" })],
      }),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(123, "Command not found.");
  });
});
