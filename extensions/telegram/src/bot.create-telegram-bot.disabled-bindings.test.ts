import type { RequestListener } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramBotCore } from "./bot-core.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
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
type DisabledScope = "session" | "channel" | "account";

describe("Telegram startup with disabled thread bindings", () => {
  let state: OpenClawTestState;
  let apiRoot: string;
  let serverTask: Promise<void>;
  const serverReady = createDeferred<string>();
  const serverRelease = createDeferred<void>();
  const bots: ReturnType<typeof createTelegramBotCore>[] = [];
  const calls: Array<{ method: string; fields: Record<string, unknown> }> = [];
  const errors = vi.fn();
  const replyResolver = vi.fn(async () => ({ text: "ordinary reply" }));
  let nextMessageId = 1000;

  const handleApiRequest: RequestListener = (request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const fields: Record<string, unknown> = body ? JSON.parse(body) : {};
      const method = request.url?.split("/").at(-1) ?? "";
      calls.push({ method, fields });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          result:
            method === "getMe"
              ? telegramBotInfoForTest
              : method === "sendMessage"
                ? { message_id: ++nextMessageId, date: 1736380800, chat, text: fields.text }
                : true,
        }),
      );
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };

  beforeAll(async () => {
    serverTask = withServer(handleApiRequest, async (url) => {
      serverReady.resolve(url);
      await serverRelease.promise;
    });
    apiRoot = await Promise.race([
      serverReady.promise,
      serverTask.then(() => {
        throw new Error("Telegram API fixture stopped before becoming ready");
      }),
    ]);
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "telegram-disabled-bindings" });
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    setTelegramPluginStateRuntimeForTests();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    );
    calls.length = 0;
    errors.mockClear();
    replyResolver.mockClear();
  });

  afterEach(async () => {
    try {
      for (const bot of bots.splice(0).toReversed()) {
        await bot.stop();
      }
      // Also release an owner leaked by a failing constructor in the pre-fix run.
      getTelegramThreadBindingManager(accountId)?.stop();
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

  afterAll(async () => {
    serverRelease.resolve();
    await serverTask;
  });

  function config(scope: DisabledScope | "enabled"): OpenClawConfig {
    return {
      agents: {
        ownership: "explicit",
        entries: { main: { workspace: state.workspaceDir } },
        defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId } }],
      commands: { native: false, nativeSkills: false },
      plugins: { enabled: false },
      session: {
        dmScope: "per-channel-peer",
        threadBindings: { enabled: scope !== "session" },
      },
      channels: {
        telegram: {
          botToken: token,
          apiRoot,
          dmPolicy: "open",
          allowFrom: ["*"],
          streaming: { mode: "off" },
          ...(scope !== "session" ? { threadBindings: { enabled: scope !== "channel" } } : {}),
          accounts: {
            [accountId]: scope === "account" ? { threadBindings: { enabled: false } } : {},
          },
        },
      },
    };
  }

  function createBot(cfg: OpenClawConfig, botToken = token) {
    const bot = createTelegramBotCore({
      token: botToken,
      accountId,
      config: cfg,
      botInfo: telegramBotInfoForTest,
      runtime: { log: () => {}, error: errors, exit: () => {} },
      telegramTransport: {
        fetch: globalThis.fetch,
        sourceFetch: globalThis.fetch,
        close: async () => {},
      },
      telegramDeps: {
        ...defaultTelegramBotDeps,
        getRuntimeConfig: () => cfg,
        syncTelegramMenuCommands: () => {},
      },
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
    const service = getSessionBindingService();
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
    expect(await getSessionBindingService().inspectByConversationAsync(conversation)).toMatchObject(
      {
        status: "unavailable",
      },
    );
    await expect(
      getSessionBindingService().resolveByConversationAsync(conversation),
    ).rejects.toMatchObject({
      code: "BINDING_ADAPTER_UNAVAILABLE",
    });
  }

  it.each(["session", "channel", "account"] as const)(
    "answers an ordinary inbound message with bindings disabled at %s scope without persisting bindings",
    async (scope) => {
      const cfg = config(scope);
      await state.writeConfig(cfg);
      const bot = createBot(cfg);
      await bot.handleUpdate({
        update_id: 1001,
        message: { message_id: 101, date: 1736380800, chat, from, text: "hello" },
      });
      expect(replyResolver, errors.mock.calls.flat().join("\n")).toHaveBeenCalledOnce();
      expect(calls.filter(({ method }) => method === "sendMessage")).toEqual([
        {
          method: "sendMessage",
          fields: expect.objectContaining({ text: "ordinary reply" }),
        },
      ]);
      const sent = calls.find(({ method }) => method === "sendMessage");
      expect(String(sent?.fields.chat_id)).toBe(String(chat.id));
      expect(errors).not.toHaveBeenCalled();
      await expectAvailableEmptyOwner();
      const service = getSessionBindingService();
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
    },
  );

  it.each([
    { previous: "channel", next: "channel" },
    { previous: "enabled", next: "channel" },
    { previous: "channel", next: "enabled" },
  ] as const)(
    "keeps the $next owner after its $previous predecessor stops repeatedly",
    async ({ previous, next }) => {
      const before = config(previous);
      await state.writeConfig(before);
      const predecessor = createBot(before);
      const after = config(next);
      await state.writeConfig(after);
      const current = createBot(after);
      await predecessor.stop();
      await predecessor.stop();
      if (next === "enabled") {
        expect(getSessionBindingService().getCapabilities(conversation).bindSupported).toBe(true);
        await expect(
          getSessionBindingService().resolveByConversationAsync(conversation),
        ).resolves.toBeNull();
      } else {
        await expectAvailableEmptyOwner();
      }
      await current.stop();
      await current.stop();
      await expectUnavailableOwner();
      expect(storedBindings()).toEqual([]);
    },
  );

  it("refuses a missing owner after an enabled bot stops", async () => {
    const cfg = config("enabled");
    await state.writeConfig(cfg);
    const bot = createBot(cfg);
    await expect(
      getSessionBindingService().resolveByConversationAsync(conversation),
    ).resolves.toBeNull();
    expect(getSessionBindingService().getCapabilities(conversation).bindSupported).toBe(true);
    await bot.stop();
    await expectUnavailableOwner();
    expect(storedBindings()).toEqual([]);
  });

  it.each(["channel", "enabled"] as const)(
    "does not retain an owner when the real bot constructor fails with %s bindings",
    async (scope) => {
      const cfg = config(scope);
      await state.writeConfig(cfg);
      expect(() => createBot(cfg, "")).toThrow("Empty token!");
      await expectUnavailableOwner();
      expect(storedBindings()).toEqual([]);
      expect(replyResolver).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    },
  );
});
