import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";
import {
  createNativeCommandTestParams,
  type NativeCommandTestParams,
} from "./bot-native-commands.fixture-test-support.js";
import type { RegisterTelegramNativeCommandsParams } from "./bot-native-commands.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

type GetPluginCommandSpecsFn =
  typeof import("openclaw/plugin-sdk/plugin-runtime").getPluginCommandSpecs;
type MatchPluginCommandFn = typeof import("openclaw/plugin-sdk/plugin-runtime").matchPluginCommand;
type ExecutePluginCommandFn =
  typeof import("openclaw/plugin-sdk/plugin-runtime").executePluginCommand;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type RecordInboundSessionMetaSafeFn =
  typeof import("openclaw/plugin-sdk/conversation-runtime").recordInboundSessionMetaSafe;
type AnyMock = MockFn<(...args: unknown[]) => unknown>;
type AnyAsyncMock = MockFn<(...args: unknown[]) => Promise<unknown>>;
type NativeCommandHarness = {
  handlers: Record<string, (ctx: unknown) => Promise<void>>;
  sendMessage: AnyAsyncMock;
  setMyCommands: AnyAsyncMock;
  log: AnyMock;
  bot: RegisterTelegramNativeCommandsParams["bot"];
};

const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn<GetPluginCommandSpecsFn>(() => []),
  matchPluginCommand: vi.fn<MatchPluginCommandFn>(() => null),
  executePluginCommand: vi.fn<ExecutePluginCommandFn>(async () => ({ text: "ok" })),
}));
export const getPluginCommandSpecs = pluginCommandMocks.getPluginCommandSpecs;
export const matchPluginCommand = pluginCommandMocks.matchPluginCommand;
export const executePluginCommand = pluginCommandMocks.executePluginCommand;

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));

const replyPipelineMocks = vi.hoisted(() => {
  const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
    queuedFinal: false,
    counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
  };
  return {
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
      async () => dispatchReplyResult,
    ),
    createChannelReplyPipeline: vi.fn(() => ({ onModelSelected: () => {} })),
    recordInboundSessionMetaSafe: vi.fn<RecordInboundSessionMetaSafeFn>(async () => undefined),
  };
});
export const dispatchReplyWithBufferedBlockDispatcher =
  replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher;

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    finalizeInboundContext: replyPipelineMocks.finalizeInboundContext,
    dispatchReplyWithBufferedBlockDispatcher:
      replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
  };
});
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    recordInboundSessionMetaSafe: replyPipelineMocks.recordInboundSessionMetaSafe,
    readChannelAllowFromStore: vi.fn(async () => []),
  };
});
vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-reply-pipeline")>();
  return {
    ...actual,
    createChannelReplyPipeline: replyPipelineMocks.createChannelReplyPipeline,
  };
});

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => {}),
}));
export const deliverReplies = deliveryMocks.deliverReplies;
vi.mock("./bot/delivery.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
vi.mock("./bot/delivery.replies.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
export { createNativeCommandTestParams };

export function createNativeCommandsHarness(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  nativeEnabled?: boolean;
  groupConfig?: Record<string, unknown>;
  resolveGroupPolicy?: () => ChannelGroupPolicy;
}): NativeCommandHarness {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage: AnyAsyncMock = vi.fn(async () => undefined);
  const setMyCommands: AnyAsyncMock = vi.fn(async () => undefined);
  const log: AnyMock = vi.fn();
  const telegramDeps = {
    loadConfig: vi.fn(() => params?.cfg ?? ({} as OpenClawConfig)),
    resolveStorePath: vi.fn((storePath?: string) => storePath ?? "/tmp/sessions.json"),
    readChannelAllowFromStore: vi.fn(async () => []),
    upsertChannelPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
    enqueueSystemEvent: vi.fn(),
    dispatchReplyWithBufferedBlockDispatcher:
      replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
    buildModelsProviderData: vi.fn(async () => ({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: { provider: "openai", model: "gpt-4.1" },
      modelNames: new Map<string, string>(),
    })),
    listSkillCommandsForAgents: vi.fn(() => []),
    syncTelegramMenuCommands: vi.fn(),
    wasSentByBot: vi.fn(() => false),
  };
  const bot = {
    api: {
      setMyCommands,
      sendMessage,
    },
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as RegisterTelegramNativeCommandsParams["bot"];

  registerTelegramNativeCommands({
    bot,
    cfg: params?.cfg ?? ({} as OpenClawConfig),
    runtime: params?.runtime ?? ({ log } as unknown as RuntimeEnv),
    accountId: "default",
    telegramCfg: params?.telegramCfg ?? ({} as TelegramAccountConfig),
    allowFrom: params?.allowFrom ?? [],
    groupAllowFrom: params?.groupAllowFrom ?? [],
    replyToMode: "off",
    textLimit: 4000,
    useAccessGroups: params?.useAccessGroups ?? false,
    nativeEnabled: params?.nativeEnabled ?? true,
    nativeSkillsEnabled: false,
    nativeDisabledExplicit: false,
    telegramDeps,
    resolveGroupPolicy:
      params?.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ChannelGroupPolicy),
    resolveTelegramGroupConfig: () => ({
      groupConfig: params?.groupConfig as undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" },
  });

  return { handlers, sendMessage, setMyCommands, log, bot };
}

export function createTelegramGroupCommandContext(params?: {
  senderId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    message: {
      chat: { id: -100999, type: "supergroup", is_forum: true },
      from: {
        id: params?.senderId ?? 12345,
        username: params?.username ?? "testuser",
      },
      message_thread_id: params?.threadId ?? 42,
      message_id: 1,
      date: 1700000000,
    },
    match: "",
  };
}

export function findNotAuthorizedCalls(sendMessage: AnyAsyncMock) {
  return sendMessage.mock.calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
  );
}
