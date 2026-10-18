import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { dispatchInboundMessage, resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTelegramBotCore } from "./bot-core.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
  resetTelegramMessageCacheForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";
import {
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import { getTelegramThreadBindingManager } from "./thread-bindings.js";

const accountId = "work";
const chat = { id: 42001, type: "private", first_name: "Alice" } as const;
const from = { id: chat.id, is_bot: false, first_name: "Alice" } as const;
const conversation = { channel: "telegram", accountId, conversationId: String(chat.id) };
const token = "123456:synthetic_disabled_binding_test";
const service = getSessionBindingService();

const { readRuntimeConfig } = vi.hoisted(() => ({
  readRuntimeConfig:
    vi.fn<typeof import("openclaw/plugin-sdk/runtime-config-snapshot").readRuntimeConfig>(),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: (...args: Parameters<typeof readRuntimeConfig>) => readRuntimeConfig(...args),
}));
vi.mock("./bot-native-command-menu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-native-command-menu.js")>()),
  syncTelegramMenuCommands: vi.fn(async () => {}),
}));

const http = useTelegramHttpFixture();
let state: OpenClawTestState;
const bots: Awaited<ReturnType<typeof createTelegramBotCore>>[] = [];
const errors = vi.fn();
const replyResolver = vi.fn(async () => ({ text: "ordinary reply" }));
let nextMessageId = 1000;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "telegram-disabled-bindings" });
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  setTelegramPluginStateRuntimeForTests();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
  );
  http.responseFor = (method, fields) =>
    method === "getMe"
      ? telegramBotInfoForTest
      : method === "sendMessage"
        ? { message_id: ++nextMessageId, date: 1736380800, chat, text: fields.text }
        : true;
  errors.mockClear();
  replyResolver.mockClear();
});

afterEach(async () => {
  try {
    for (const bot of bots.splice(0).toReversed()) {
      await bot.stop();
    }
    // Also release an owner leaked by a failing constructor in the pre-fix run.
    await getTelegramThreadBindingManager(accountId)?.stop();
  } finally {
    resetTelegramClientOptionsCacheForTests();
    resetTelegramAccountThrottlersForTest();
    resetTelegramMessageCacheForTest();
    resetTelegramSentMessageCacheForTest();
    clearTelegramRuntimeForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    resetPluginRuntimeStateForTest();
    resetInboundDedupe();
    resetPluginStateStoreForTests();
    await state.cleanup();
  }
});

async function createBot(scope: "channel" | "account" | "enabled", botToken = token) {
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: state.workspaceDir } },
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
    },
    bindings: [{ agentId: "main", match: { channel: "telegram", accountId } }],
    commands: { native: false, nativeSkills: false },
    messages: { inbound: { debounceMs: 0 } },
    plugins: { enabled: false },
    session: { dmScope: "per-channel-peer", threadBindings: { enabled: true } },
    channels: {
      telegram: {
        botToken: token,
        apiRoot: http.cfg.channels.telegram.apiRoot,
        dmPolicy: "open",
        allowFrom: ["*"],
        streaming: { mode: "off" },
        threadBindings: { enabled: scope !== "channel" },
        accounts: {
          [accountId]: scope === "account" ? { threadBindings: { enabled: false } } : {},
        },
      },
    },
  };
  await state.writeConfig(cfg);
  readRuntimeConfig.mockReturnValue(cfg);
  const bot = await createTelegramBotCore({
    token: botToken,
    accountId,
    config: cfg,
    botInfo: telegramBotInfoForTest,
    runtime: { log: () => {}, error: errors, exit: () => {} },
    telegramTransport: { fetch, sourceFetch: fetch, close: async () => {} },
    // Keep startup, inbound assembly, core gather, and delivery real; isolate model execution.
    dispatchReplyFromConfig: (params) => dispatchInboundMessage({ ...params, replyResolver }),
  });
  bots.push(bot);
  return bot;
}

function storedBindings() {
  return createPluginStateSyncKeyedStoreForTests<TelegramThreadBindingRecord>("telegram", {
    namespace: TELEGRAM_THREAD_BINDINGS_NAMESPACE,
    maxEntries: TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  }).entries();
}

async function expectAvailableEmptyOwner() {
  expect(service.getCapabilities(conversation)).toEqual({
    adapterAvailable: true,
    bindSupported: false,
    unbindSupported: false,
    placements: [],
  });
  expect(await service.inspectByConversationAsync(conversation)).toMatchObject({
    status: "available",
    binding: null,
  });
  await expect(service.resolveByConversationAsync(conversation)).resolves.toBeNull();
}

async function expectUnavailableOwner() {
  expect(await service.inspectByConversationAsync(conversation)).toMatchObject({
    status: "unavailable",
  });
  await expect(service.resolveByConversationAsync(conversation)).rejects.toMatchObject({
    code: "BINDING_ADAPTER_UNAVAILABLE",
  });
}

it("answers an ordinary inbound message with account bindings disabled without persisting bindings", async () => {
  const bot = await createBot("account");
  await bot.handleUpdate({
    update_id: 1001,
    message: { message_id: 101, date: 1736380800, chat, from, text: "hello" },
  });
  expect(replyResolver, errors.mock.calls.flat().join("\n")).toHaveBeenCalledOnce();
  const sent = http.requests.filter(({ method }) => method === "sendMessage");
  expect(sent).toEqual([
    { method: "sendMessage", fields: expect.objectContaining({ text: "ordinary reply" }) },
  ]);
  expect(String(sent[0]?.fields.chat_id)).toBe(String(chat.id));
  expect(errors).not.toHaveBeenCalled();
  await expectAvailableEmptyOwner();
  const targetSessionKey = "agent:main:subagent:synthetic-child";
  await expect(
    service.bind({
      conversation,
      targetSessionKey,
      targetKind: "subagent",
      placement: "current",
    }),
  ).rejects.toMatchObject({ code: "BINDING_CAPABILITY_UNSUPPORTED" });
  await expect(
    service.unbind({ scope: conversation, targetSessionKey, reason: "test" }),
  ).resolves.toEqual([]);
  expect(storedBindings()).toEqual([]);
  await bot.stop();
  await expectUnavailableOwner();
  expect(storedBindings()).toEqual([]);
});

it.each([
  ["channel", "channel"],
  ["enabled", "channel"],
  ["channel", "enabled"],
] as const)("keeps replacement owner: %s → %s", async (previous, next) => {
  const predecessor = await createBot(previous);
  const current = await createBot(next);
  await predecessor.stop();
  await predecessor.stop();
  if (next === "enabled") {
    expect(service.getCapabilities(conversation).bindSupported).toBe(true);
    await expect(service.resolveByConversationAsync(conversation)).resolves.toBeNull();
  } else {
    await expectAvailableEmptyOwner();
  }
  await current.stop();
  await current.stop();
  await expectUnavailableOwner();
  expect(storedBindings()).toEqual([]);
});

it("does not retain an owner when the real bot constructor fails with enabled bindings", async () => {
  await expect(createBot("enabled", "")).rejects.toThrow("Empty token!");
  await expectUnavailableOwner();
  expect(storedBindings()).toEqual([]);
  expect(replyResolver).not.toHaveBeenCalled();
  expect(http.requests).toEqual([]);
});
