import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig } from "openclaw/plugin-sdk/telegram";
import { expect, vi } from "vitest";
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
  setMyCommands: ReturnType<typeof vi.fn>;
};

const skillCommandMocks = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

export const listSkillCommandsForAgents = skillCommandMocks.listSkillCommandsForAgents;
export const deliverReplies = deliveryMocks.deliverReplies;

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    listSkillCommandsForAgents,
  };
});

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
}));

export async function waitForRegisteredCommands(
  setMyCommands: ReturnType<typeof vi.fn>,
): Promise<RegisteredCommand[]> {
  await vi.waitFor(() => {
    expect(setMyCommands).toHaveBeenCalled();
  });
  return setMyCommands.mock.calls[0]?.[0] as RegisteredCommand[];
}

export function resetNativeCommandMenuMocks() {
  listSkillCommandsForAgents.mockClear();
  listSkillCommandsForAgents.mockReturnValue([]);
  deliverReplies.mockClear();
  deliverReplies.mockResolvedValue({ delivered: true });
}

export function createCommandBot(): CreateCommandBotResult {
  const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const bot = {
    api: {
      setMyCommands,
      sendMessage,
    },
    command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
      commandHandlers.set(name, cb);
    }),
  } as unknown as RegisterTelegramNativeCommandsParams["bot"];
  return { bot, commandHandlers, sendMessage, setMyCommands };
}

export function createNativeCommandTestParams(
  cfg: OpenClawConfig,
  params: Partial<RegisterTelegramNativeCommandsParams> = {},
): RegisterTelegramNativeCommandsParams {
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
