// Telegram plugin module implements bot native commands.menu test support behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
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

const nativeCommandMocks = vi.hoisted(() => ({
  getRuntimeConfig:
    vi.fn<typeof import("openclaw/plugin-sdk/runtime-config-snapshot").readRuntimeConfig>(),
  readChannelAllowFromStore: vi.fn<
    typeof import("openclaw/plugin-sdk/conversation-runtime").readChannelAllowFromStore
  >(async () => []),
  prepareSkillCommandsForAgents: vi.fn<
    typeof import("openclaw/plugin-sdk/skill-commands-runtime").prepareSkillCommandsForAgents
  >(async () => []),
  syncTelegramMenuCommands:
    vi.fn<typeof import("./bot-native-command-menu.js").syncTelegramMenuCommands>(),
  runModelsAuthLoginFlow:
    vi.fn<
      typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime").runModelsAuthLoginFlow
    >(),
  sendMessageTelegram: vi.fn<typeof import("./send.js").sendMessageTelegram>(),
  editMessageTelegram: vi.fn<typeof import("./send.js").editMessageTelegram>(),
}));
export { nativeCommandMocks };

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<typeof import("./bot/delivery.replies.js").deliverReplies>(async () => ({
    delivered: true,
  })),
}));

export const prepareSkillCommandsForAgents = nativeCommandMocks.prepareSkillCommandsForAgents;
export const deliverReplies = deliveryMocks.deliverReplies;

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: (...args: Parameters<typeof nativeCommandMocks.getRuntimeConfig>) =>
    nativeCommandMocks.getRuntimeConfig(...args),
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: (
    ...args: Parameters<typeof nativeCommandMocks.readChannelAllowFromStore>
  ) => nativeCommandMocks.readChannelAllowFromStore(...args),
}));
vi.mock("openclaw/plugin-sdk/skill-commands-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/skill-commands-runtime")>()),
  prepareSkillCommandsForAgents: (...args: Parameters<typeof prepareSkillCommandsForAgents>) =>
    nativeCommandMocks.prepareSkillCommandsForAgents(...args),
}));
vi.mock("./bot-native-command-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-native-command-menu.js")>()),
  syncTelegramMenuCommands: (
    ...args: Parameters<typeof nativeCommandMocks.syncTelegramMenuCommands>
  ) => nativeCommandMocks.syncTelegramMenuCommands(...args),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-login-flow-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime")>();
  return {
    ...actual,
    runProviderChannelLoginFlow: (
      params: Parameters<typeof actual.runProviderChannelLoginFlow>[0],
    ) =>
      actual.runProviderChannelLoginFlow({
        ...params,
        runLoginFlow: (...args) => nativeCommandMocks.runModelsAuthLoginFlow(...args),
      }),
  };
});
vi.mock("./send-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send-runtime.js")>()),
  loadTelegramSendModule: async () => ({
    sendMessageTelegram: (...args: Parameters<typeof nativeCommandMocks.sendMessageTelegram>) =>
      nativeCommandMocks.sendMessageTelegram(...args),
    editMessageTelegram: (...args: Parameters<typeof nativeCommandMocks.editMessageTelegram>) =>
      nativeCommandMocks.editMessageTelegram(...args),
  }),
}));

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
): RegisterTelegramNativeCommandsParams {
  nativeCommandMocks.getRuntimeConfig.mockReset().mockReturnValue(cfg);
  nativeCommandMocks.readChannelAllowFromStore.mockReset().mockResolvedValue([]);
  nativeCommandMocks.syncTelegramMenuCommands
    .mockReset()
    .mockImplementation(async ({ bot, commandsToRegister }) => {
      if (commandsToRegister.length > 0) {
        await bot.api.setMyCommands(commandsToRegister);
      }
    });
  nativeCommandMocks.sendMessageTelegram
    .mockReset()
    .mockResolvedValue({ messageId: "999", chatId: "100" });
  nativeCommandMocks.runModelsAuthLoginFlow.mockReset().mockImplementation(async (...args) => {
    const actual = await vi.importActual<
      typeof import("openclaw/plugin-sdk/provider-auth-login-flow-runtime")
    >("openclaw/plugin-sdk/provider-auth-login-flow-runtime");
    return await actual.runModelsAuthLoginFlow(...args);
  });
  nativeCommandMocks.editMessageTelegram.mockReset().mockImplementation(async () => {
    throw new Error("Native menu fixtures do not edit progress messages");
  });
  return createBaseNativeCommandTestParams({
    cfg,
    runtime: params.runtime ?? ({} as RuntimeEnv),
    nativeSkillsEnabled: true,
    ...params,
  });
}

export function createPrivateCommandContext(
  params?: Parameters<typeof createTelegramPrivateCommandContext>[0],
) {
  return createTelegramPrivateCommandContext(params);
}
