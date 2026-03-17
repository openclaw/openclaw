import { vi } from "vitest";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" }))
}));
const getPluginCommandSpecs = pluginCommandMocks.getPluginCommandSpecs;
const matchPluginCommand = pluginCommandMocks.matchPluginCommand;
const executePluginCommand = pluginCommandMocks.executePluginCommand;
vi.mock("../../../src/plugins/commands.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => {
  })
}));
const deliverReplies = deliveryMocks.deliverReplies;
vi.mock("./bot/delivery.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => [])
}));
function createNativeCommandTestParams(params = {}) {
  const log = vi.fn();
  return {
    bot: params.bot ?? {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(void 0),
        sendMessage: vi.fn().mockResolvedValue(void 0)
      },
      command: vi.fn()
    },
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? { log },
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? {},
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    replyToMode: params.replyToMode ?? "off",
    textLimit: params.textLimit ?? 4e3,
    useAccessGroups: params.useAccessGroups ?? false,
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    nativeDisabledExplicit: params.nativeDisabledExplicit ?? false,
    resolveGroupPolicy: params.resolveGroupPolicy ?? (() => ({
      allowlistEnabled: false,
      allowed: true
    })),
    resolveTelegramGroupConfig: params.resolveTelegramGroupConfig ?? (() => ({ groupConfig: void 0, topicConfig: void 0 })),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    opts: params.opts ?? { token: "token" }
  };
}
function createNativeCommandsHarness(params) {
  const handlers = {};
  const sendMessage = vi.fn(async () => void 0);
  const setMyCommands = vi.fn(async () => void 0);
  const log = vi.fn();
  const bot = {
    api: {
      setMyCommands,
      sendMessage
    },
    command: (name, handler) => {
      handlers[name] = handler;
    }
  };
  registerTelegramNativeCommands({
    bot,
    cfg: params?.cfg ?? {},
    runtime: params?.runtime ?? { log },
    accountId: "default",
    telegramCfg: params?.telegramCfg ?? {},
    allowFrom: params?.allowFrom ?? [],
    groupAllowFrom: params?.groupAllowFrom ?? [],
    replyToMode: "off",
    textLimit: 4e3,
    useAccessGroups: params?.useAccessGroups ?? false,
    nativeEnabled: params?.nativeEnabled ?? true,
    nativeSkillsEnabled: false,
    nativeDisabledExplicit: false,
    resolveGroupPolicy: params?.resolveGroupPolicy ?? (() => ({
      allowlistEnabled: false,
      allowed: true
    })),
    resolveTelegramGroupConfig: () => ({
      groupConfig: params?.groupConfig,
      topicConfig: void 0
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" }
  });
  return { handlers, sendMessage, setMyCommands, log, bot };
}
function createTelegramGroupCommandContext(params) {
  return {
    message: {
      chat: { id: -100999, type: "supergroup", is_forum: true },
      from: {
        id: params?.senderId ?? 12345,
        username: params?.username ?? "testuser"
      },
      message_thread_id: params?.threadId ?? 42,
      message_id: 1,
      date: 17e8
    },
    match: ""
  };
}
function findNotAuthorizedCalls(sendMessage) {
  return sendMessage.mock.calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("not authorized")
  );
}
export {
  createNativeCommandTestParams,
  createNativeCommandsHarness,
  createTelegramGroupCommandContext,
  deliverReplies,
  executePluginCommand,
  findNotAuthorizedCalls,
  getPluginCommandSpecs,
  matchPluginCommand
};
