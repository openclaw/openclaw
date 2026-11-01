import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type * as MediaRuntime from "openclaw/plugin-sdk/media-runtime";
import type * as ModelsRuntime from "openclaw/plugin-sdk/models-provider-runtime";
import {
  createChannelIngressQueueForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
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
import type * as SkillRuntime from "openclaw/plugin-sdk/skill-commands-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { createTelegramBot } from "./bot.js";
import { apiThrottler } from "./bot.runtime.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { getTelegramRuntime, setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
} from "./runtime.test-support.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

const {
  saveRemoteMedia,
  transcribeFirstAudio,
  buildModelsProviderData,
  prepareSkillCommandsForAgents,
} = vi.hoisted(() => ({
  saveRemoteMedia: vi.fn<typeof MediaRuntime.saveRemoteMedia>(),
  transcribeFirstAudio: vi.fn<typeof MediaRuntime.transcribeFirstAudio>(),
  buildModelsProviderData: vi.fn<typeof ModelsRuntime.buildPreparedModelsProviderData>(),
  prepareSkillCommandsForAgents: vi.fn<typeof SkillRuntime.prepareSkillCommandsForAgents>(),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof MediaRuntime>()),
  saveRemoteMedia,
  transcribeFirstAudio,
}));
const http = useTelegramHttpFixture();

type ReplyResolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>;
const replySpy = vi.fn<ReplyResolver>();
const pendingUpdates = new Set<Promise<void>>();
const pendingMenuSyncs = new Set<Promise<void>>();

vi.mock("openclaw/plugin-sdk/models-provider-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelsRuntime>()),
  buildPreparedModelsProviderData: buildModelsProviderData,
}));
vi.mock("openclaw/plugin-sdk/skill-commands-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SkillRuntime>()),
  prepareSkillCommandsForAgents,
}));
vi.mock("./bot-native-command-menu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bot-native-command-menu.js")>();
  return {
    ...actual,
    syncTelegramMenuCommands: (params: Parameters<typeof actual.syncTelegramMenuCommands>[0]) => {
      const pending = actual.syncTelegramMenuCommands(params);
      pendingMenuSyncs.add(pending);
      return pending;
    },
  };
});

export async function settleMenuSyncs(): Promise<void> {
  await Promise.all(pendingMenuSyncs);
  pendingMenuSyncs.clear();
}

async function settleUpdates(): Promise<void> {
  while (pendingUpdates.size > 0) {
    await Promise.allSettled(pendingUpdates);
  }
}

// Keep declaration emit from inferring the private command-dispatch symbol into this export.
export const harness: {
  readonly state: OpenClawTestState;
  replySpy: Mock<ReplyResolver>;
  transcribeFirstAudio: typeof transcribeFirstAudio;
  settleUpdates: typeof settleUpdates;
  prepareSkillCommandsForAgents: typeof prepareSkillCommandsForAgents;
  buildModelsProviderData: typeof buildModelsProviderData;
} = {
  get state() {
    return state;
  },
  replySpy,
  transcribeFirstAudio,
  settleUpdates,
  prepareSkillCommandsForAgents,
  buildModelsProviderData,
};
const bots: Array<{ bot: Bot; abort: AbortController }> = [];
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

export async function createBot(
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
  const bot = await createTelegramBot({
    token,
    botInfo: {
      ...telegramBotInfoForTest,
      id: resolveTelegramBotUserIdFromToken(token) ?? telegramBotInfoForTest.id,
      has_topics_enabled: dmTopicsEnabled,
    },
    config: cfg,
    accountId,
    fetchAbortSignal: abort.signal,
    telegramTransport: { fetch, sourceFetch: fetch, close: async () => {} },
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
  bots.push({ bot, abort });
  return bot;
}

export async function admitSpooledUpdate(
  bot: Awaited<ReturnType<typeof createBot>>,
  update: unknown,
) {
  const runtime = getTelegramRuntime();
  setTelegramRuntime({
    ...runtime,
    state: {
      ...runtime.state,
      openChannelIngressQueue: (options) =>
        createChannelIngressQueueForTests({ ...options, channelId: "telegram" }),
    },
  });
  try {
    const monitor = createTelegramTransportIngressMonitor({
      bot,
      accountId: "default",
      botInfo: bot.botInfo,
    });
    try {
      monitor.start();
      const admission = await monitor.admit(update);
      await monitor.waitForIdle();
      await monitor.waitForDeferredClaims();
      return admission;
    } finally {
      await monitor.stop();
    }
  } finally {
    setTelegramRuntime(runtime);
  }
}

let messageId = 10000;

// Use the ingress path without grammY's wall-clock webhook deadline on cold workers.
export async function deliverTelegramUpdate(bot: Bot, update: object): Promise<void> {
  // Round-trip Telegram's JSON shape, omitting undefined fields just like the webhook adapter.
  await bot.handleUpdate(await new Response(JSON.stringify(update)).json());
}

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
  transcribeFirstAudio.mockReset();
  prepareSkillCommandsForAgents.mockReset().mockImplementation(async (...args) => {
    const actual = await vi.importActual<typeof SkillRuntime>(
      "openclaw/plugin-sdk/skill-commands-runtime",
    );
    return await actual.prepareSkillCommandsForAgents(...args);
  });
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
  } satisfies MediaRuntime.SavedRemoteMedia);
});

afterEach(async () => {
  // A webhook deadline does not cancel handleUpdate; abort its transport before joining.
  for (const { abort } of bots) {
    abort.abort();
  }
  await settleUpdates();
  await settleMenuSyncs();
  await Promise.all(bots.splice(0).map(({ bot }) => bot.stop()));
  clearRuntimeConfigSnapshot();
  clearTelegramRuntimeForTest();
  resetPluginRuntimeStateForTest();
  // The state owner drains agent workers before retiring their shared-state admission.
  resetPluginStateStoreForTests({ closeDatabase: false });
  await state.cleanup();
});
