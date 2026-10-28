import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import {
  getSessionBindingService,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTelegramBotCore } from "./bot-core.js";
import {
  apiCalls,
  chat,
  from,
  createBot as createNativeBot,
  harness,
  publishTelegramTestConfig,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import {
  resetTelegramMessageCacheForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import {
  TELEGRAM_THREAD_BINDINGS_MAX_ENTRIES,
  TELEGRAM_THREAD_BINDINGS_NAMESPACE,
  type TelegramThreadBindingRecord,
} from "./thread-bindings-store.js";
import { getTelegramThreadBindingManager } from "./thread-bindings.js";

const accountId = "work";
const conversation = { channel: "telegram", accountId, conversationId: String(chat.id) };
const token = "123456:synthetic_disabled_binding_test";
const service = getSessionBindingService();

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  harness.replySpy.mockResolvedValue({ text: "ordinary reply" });
});

afterEach(async () => {
  try {
    // Also release an owner leaked by a failing constructor in the pre-fix run.
    await getTelegramThreadBindingManager(accountId)?.stop();
  } finally {
    resetInboundDedupe();
    resetTelegramMessageCacheForTest();
    resetTelegramSentMessageCacheForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
  }
});

async function createBot(scope: "channel" | "account" | "enabled", botToken = token) {
  const state = harness.state;
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
  publishTelegramTestConfig(cfg);
  await state.writeConfig(cfg);
  if (botToken) {
    return createNativeBot(false, true, cfg, false, accountId);
  }
  return createTelegramBotCore({
    token: botToken,
    accountId,
    config: cfg,
    botInfo: telegramBotInfoForTest,
    telegramTransport: { fetch, sourceFetch: fetch, close: async () => {} },
  });
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
  const sent = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
  expect(sent).toEqual([["sendMessage", expect.objectContaining({ text: "ordinary reply" })]]);
  const payload = sent[0]?.[1];
  expect(isRecord(payload) ? String(payload.chat_id) : undefined).toBe(String(chat.id));
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
  expect(harness.replySpy).not.toHaveBeenCalled();
  expect(apiCalls).not.toHaveBeenCalled();
});
