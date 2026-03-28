import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expect, vi } from "vitest";
import type { SkillCommandSpec } from "../../../src/agents/skills.js";
import type { OpenClawConfig } from "../runtime-api.js";
import type { TelegramBotDeps } from "./bot-deps.js";
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
  listSkillCommandsForAgents: vi.fn<
    (params: { cfg: OpenClawConfig; agentIds?: string[] }) => SkillCommandSpec[]
  >(() => []),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

export const listSkillCommandsForAgents = skillCommandMocks.listSkillCommandsForAgents;
export const deliverReplies = deliveryMocks.deliverReplies;

vi.mock("openclaw/plugin-sdk/command-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/command-auth")>();
  return {
    ...actual,
    listSkillCommandsForAgents,
  };
});

vi.mock("./bot/delivery.js", () => ({
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
  const dispatchResult: Awaited<
    ReturnType<TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]>
  > = {
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  };
  const telegramDeps: TelegramBotDeps = {
    loadConfig: vi.fn(() => cfg) as TelegramBotDeps["loadConfig"],
    resolveStorePath: vi.fn(
      (storePath?: string) => storePath ?? "/tmp/sessions.json",
    ) as TelegramBotDeps["resolveStorePath"],
    readChannelAllowFromStore: vi.fn(
      async () => [],
    ) as TelegramBotDeps["readChannelAllowFromStore"],
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })) as TelegramBotDeps["upsertChannelPairingRequest"],
    enqueueSystemEvent: vi.fn() as TelegramBotDeps["enqueueSystemEvent"],
    dispatchReplyWithBufferedBlockDispatcher: vi.fn(
      async () => dispatchResult,
    ) as TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"],
    buildModelsProviderData: vi.fn(async () => ({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-4.1" },
      modelNames: new Map<string, string>(),
    })) as TelegramBotDeps["buildModelsProviderData"],
    listSkillCommandsForAgents,
    wasSentByBot: vi.fn(() => false) as TelegramBotDeps["wasSentByBot"],
  };
  return createBaseNativeCommandTestParams({
    cfg,
    runtime: params.runtime ?? ({} as RuntimeEnv),
    nativeSkillsEnabled: true,
    telegramDeps,
    ...params,
  });
}

export function createPrivateCommandContext(
  params?: Parameters<typeof createTelegramPrivateCommandContext>[0],
) {
  return createTelegramPrivateCommandContext(params);
}
