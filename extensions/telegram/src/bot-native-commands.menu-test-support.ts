// Telegram plugin module implements bot native commands.menu test support behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import {
  createNativeCommandTestParams as createBaseNativeCommandTestParams,
  createTelegramPrivateCommandContext,
  type NativeCommandTestParams as RegisterTelegramNativeCommandsParams,
} from "./bot-native-commands.fixture-test-support.js";

type RegisteredCommand = {
  command: string;
  description: string;
};

type CreateCommandBotResult = {
  bot: RegisterTelegramNativeCommandsParams["bot"];
  commandHandlers: Map<string, (ctx: unknown) => Promise<void>>;
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
};
type CreateCommandBotParams = {
  api?: Record<string, unknown>;
};

const skillCommandMocks = vi.hoisted(() => ({
  prepareSkillCommandsForAgents: vi.fn<TelegramNativeCommandDeps["prepareSkillCommandsForAgents"]>(
    async () => [],
  ),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<typeof import("./bot/delivery.replies.js").deliverReplies>(async () => ({
    delivered: true,
  })),
}));

export const prepareSkillCommandsForAgents = skillCommandMocks.prepareSkillCommandsForAgents;
export const deliverReplies = deliveryMocks.deliverReplies;

// Vitest hoists this factory before static imports are initialized.
vi.mock("./bot/delivery.js", async () => ({
  ...(await import("./bot/delivery.hooks.js")),
  deliverReplies,
}));

vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies,
}));

export async function waitForRegisteredCommands(
  setMyCommands: ReturnType<typeof vi.fn>,
): Promise<RegisteredCommand[]> {
  await vi.waitFor(() => {
    expect(setMyCommands).toHaveBeenCalled();
  });
  return setMyCommands.mock.calls.at(0)?.[0] as RegisteredCommand[];
}

export function resetNativeCommandMenuMocks() {
  prepareSkillCommandsForAgents.mockClear();
  prepareSkillCommandsForAgents.mockResolvedValue([]);
  deliverReplies.mockClear();
  deliverReplies.mockResolvedValue({ delivered: true });
}

export function createCommandBot(params: CreateCommandBotParams = {}): CreateCommandBotResult {
  const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
  const deleteMessage = vi.fn().mockResolvedValue(true);
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const bot = {
    api: {
      setMyCommands,
      sendMessage,
      deleteMessage,
      ...params.api,
    },
    command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
      commandHandlers.set(name, cb);
    }),
  } as unknown as RegisterTelegramNativeCommandsParams["bot"];
  return { bot, commandHandlers, sendMessage, deleteMessage, setMyCommands };
}

export function createNativeCommandTestParams(
  cfg: OpenClawConfig,
  params: Partial<RegisterTelegramNativeCommandsParams> = {},
): RegisterTelegramNativeCommandsParams & { telegramDeps: TelegramNativeCommandDeps } {
  const telegramDeps: TelegramNativeCommandDeps = {
    getRuntimeConfig: vi.fn(() => cfg) as TelegramNativeCommandDeps["getRuntimeConfig"],
    readChannelAllowFromStore: vi.fn(
      async () => [],
    ) as TelegramNativeCommandDeps["readChannelAllowFromStore"],
    prepareSkillCommandsForAgents,
    syncTelegramMenuCommands: vi.fn(async ({ bot, commandsToRegister }) => {
      if (commandsToRegister.length > 0) {
        await bot.api.setMyCommands(commandsToRegister);
      }
    }) as TelegramNativeCommandDeps["syncTelegramMenuCommands"],
    sendMessageTelegram: vi.fn(async () => ({ messageId: "999", chatId: "100" })),
  };
  return {
    ...createBaseNativeCommandTestParams({
      cfg,
      runtime: params.runtime ?? ({} as RuntimeEnv),
      nativeSkillsEnabled: true,
      ...params,
    }),
    telegramDeps: params.telegramDeps ?? telegramDeps,
  };
}

export function createPrivateCommandContext(
  params?: Parameters<typeof createTelegramPrivateCommandContext>[0],
) {
  return createTelegramPrivateCommandContext(params);
}
