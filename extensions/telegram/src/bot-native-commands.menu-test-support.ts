import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import {
  createNativeCommandTestParams as createBaseNativeCommandTestParams,
  createTelegramPrivateCommandContext,
  type NativeCommandTestParams as RegisterTelegramNativeCommandsParams,
} from "./bot-native-commands.fixture-test-support.js";

type RegisteredCommand = {
  command: string;
  description: string;
};

const skillCommandMocks = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

export const listSkillCommandsForAgents = skillCommandMocks.listSkillCommandsForAgents;
export const deliverReplies = deliveryMocks.deliverReplies;

vi.mock("../../../src/auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auto-reply/skill-commands.js")>();
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

export function createCommandBot() {
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

export { createTelegramPrivateCommandContext as createPrivateCommandContext };
