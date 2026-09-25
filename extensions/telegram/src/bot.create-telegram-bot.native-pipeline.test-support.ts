import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SavedRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, vi } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import {
  enqueueTelegramMenuSync,
  resolveTelegramMenuRemoteOwner,
} from "./bot-native-command-menu-state.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import { apiThrottler } from "./bot.runtime.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
} from "./runtime.test-support.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

const saveRemoteMedia = vi.fn();
vi.mock("./telegram-media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telegram-media.runtime.js")>()),
  saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
}));
const http = useTelegramHttpFixture();

type ReplyResolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>;
const replySpy = vi.fn<ReplyResolver>();
const buildModelsProviderData = vi.fn(defaultTelegramBotDeps.buildModelsProviderData);
const listSkillCommandsForAgents = vi.fn(defaultTelegramBotDeps.listSkillCommandsForAgents);
const pendingUpdates = new Set<Promise<void>>();

async function settleUpdates(): Promise<void> {
  while (pendingUpdates.size > 0) {
    await Promise.allSettled(pendingUpdates);
  }
}

export const harness = {
  get state() {
    return state;
  },
  replySpy,
  settleUpdates,
  listSkillCommandsForAgents,
  telegramBotDepsForTest: {
    ...defaultTelegramBotDeps,
    buildModelsProviderData,
    listSkillCommandsForAgents,
  },
};
const bots: Array<{ bot: Bot; abort: AbortController }> = [];
const menuOwnerIds = new Set<number>();
export const chat = { id: 42001, type: "private", first_name: "Alice" } as const;
export const from = { id: 42001, is_bot: false, first_name: "Alice" } as const;
export const groupChat = {
  id: -10042001,
  type: "supergroup",
  title: "Test group",
  is_forum: true,
} as const;
export const photo = [
  { file_id: "photo-1", file_unique_id: "photo-unique", width: 10, height: 10 },
];
export const apiCalls = vi.fn<(method: string, payload: unknown) => void>();
export const apiResponses = new Map<string, { ok: true; result: unknown }>();
const syntheticTokens = new Map<string, string>();

export function publishTelegramTestConfig(cfg: OpenClawConfig): void {
  const channels = (cfg.channels ??= {});
  const telegram = (channels.telegram ??= {});
  const namedAccounts = Object.entries(telegram.accounts ?? {});
  const inheritsAuthoredCredentials =
    Object.hasOwn(telegram, "botToken") || Object.hasOwn(telegram, "tokenFile");
  telegram.apiRoot ??= http.cfg.channels.telegram.apiRoot;
  for (const [accountId, account] of [["default", telegram], ...namedAccounts] as const) {
    account.apiRoot ??= telegram.apiRoot;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(account.apiRoot).hostname)) {
      throw new Error("Telegram test config must use an owned loopback Bot API");
    }
    if (
      (account === telegram || !inheritsAuthoredCredentials) &&
      (account !== telegram || namedAccounts.length === 0) &&
      telegram.enabled !== false &&
      account.enabled !== false &&
      !Object.hasOwn(account, "botToken") &&
      !Object.hasOwn(account, "tokenFile")
    ) {
      let token = syntheticTokens.get(accountId);
      if (!token) {
        token = `${telegramBotInfoForTest.id + syntheticTokens.size}:native-test-token`;
        syntheticTokens.set(accountId, token);
      }
      account.botToken = token;
    }
  }
  setRuntimeConfigSnapshot(cfg);
}

export function createBot(
  native = true,
  text = true,
  override?: OpenClawConfig,
  dmTopicsEnabled = false,
  accountId?: string,
) {
  const cfg: OpenClawConfig = override ?? {
    commands: { native, text },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"], streaming: { mode: "off" } } },
  };
  // These fixtures admit discrete messages; batching cases retain their authored windows.
  const messages = (cfg.messages ??= {});
  const inbound = (messages.inbound ??= {});
  inbound.debounceMs ??= 0;
  publishTelegramTestConfig(cfg);
  const abort = new AbortController();
  const token = resolveTelegramAccount({ cfg, accountId }).token;
  // Routing and delivery assertions retain real scheduling without wall-clock pacing.
  getOrCreateAccountThrottler(token, () =>
    apiThrottler({
      global: {},
      group: { maxConcurrent: 1 },
      out: { maxConcurrent: 1 },
    }),
  );
  const botInfo = {
    ...telegramBotInfoForTest,
    id: resolveTelegramBotUserIdFromToken(token) ?? telegramBotInfoForTest.id,
    has_topics_enabled: dmTopicsEnabled,
  };
  const bot = createTelegramBot({
    token,
    botInfo,
    config: cfg,
    accountId,
    fetchAbortSignal: abort.signal,
    telegramTransport: { fetch, sourceFetch: fetch, close: async () => {} },
    telegramDeps: harness.telegramBotDepsForTest,
    dispatchReplyFromConfig: (params) =>
      dispatchInboundMessage({ ...params, replyResolver: replySpy }),
  });
  const handleUpdate = bot.handleUpdate.bind(bot);
  bot.handleUpdate = (...args) => {
    const pending = handleUpdate(...args);
    pendingUpdates.add(pending);
    void pending.then(
      () => pendingUpdates.delete(pending),
      () => pendingUpdates.delete(pending),
    );
    return pending;
  };
  menuOwnerIds.add(botInfo.id);
  bots.push({ bot, abort });
  return bot;
}

let messageId = 10000;

export function nextTelegramTestMessageId(): number {
  return ++messageId;
}

export function commandMessage(text: string) {
  const commandEnd = text.search(/\s/u);
  return {
    message_id: nextTelegramTestMessageId(),
    date: 1736380800,
    chat,
    from,
    text,
    entities: [
      { type: "bot_command", offset: 0, length: commandEnd < 0 ? text.length : commandEnd },
    ],
  } satisfies Message.TextMessage;
}

export function groupCommand(text = "/status", threadId = 99) {
  return {
    ...commandMessage(text),
    chat: groupChat,
    message_thread_id: threadId,
    is_topic_message: true,
  };
}

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "telegram-native-pipeline" });
  resetPluginStateStoreForTests({ closeDatabase: false });
  resetTelegramAccountThrottlersForTest();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  apiCalls.mockReset();
  apiResponses.clear();
  syntheticTokens.clear();
  http.responseFor = (method, fields) => {
    apiCalls(method, fields);
    if (apiResponses.has(method)) {
      return apiResponses.get(method)!.result;
    }
    if (method === "getFile") {
      return {
        file_id: String(fields.file_id),
        file_unique_id: String(fields.file_id),
        file_path: "photo.jpg",
      };
    }
    return undefined;
  };
  replySpy.mockReset().mockResolvedValue({ text: "Test response" });
  listSkillCommandsForAgents
    .mockReset()
    .mockImplementation(defaultTelegramBotDeps.listSkillCommandsForAgents);
  buildModelsProviderData.mockReset().mockResolvedValue({
    byProvider: new Map(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "gpt-test" },
    modelNames: new Map(),
    modelCatalog: [],
  });
  setTelegramPluginStateRuntimeForTests();
  saveRemoteMedia.mockReset().mockResolvedValue({
    id: "replied-photo.jpg",
    path: "/tmp/replied-photo.jpg",
    size: 4,
    contentType: "image/jpeg",
  } satisfies SavedRemoteMedia);
});

afterEach(async () => {
  // A webhook deadline does not cancel handleUpdate; abort its transport before joining.
  for (const { abort } of bots) {
    abort.abort();
  }
  await settleUpdates();
  for (const botId of menuOwnerIds) {
    await new Promise<void>((resolve, reject) => {
      enqueueTelegramMenuSync({
        ownerKey: resolveTelegramMenuRemoteOwner({ botId }).queueKey,
        sync: async () => resolve(),
        onError: reject,
      });
    });
  }
  menuOwnerIds.clear();
  await Promise.all(bots.splice(0).map(({ bot }) => bot.stop()));
  clearRuntimeConfigSnapshot();
  clearTelegramRuntimeForTest();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
  await state.cleanup();
});
