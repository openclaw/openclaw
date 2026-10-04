import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { retireTelegramStreamPreviewAcrossAccounts } from "./preview-retirement.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";

const groupChatId = -1007;
const groupChat = { id: groupChatId, type: "supergroup" as const, title: "History" };

function message(messageId: number, text: string, chat: Message["chat"] = groupChat): Message {
  return {
    message_id: messageId,
    date: 1_736_371_600 + messageId,
    chat,
    from: { id: 42, is_bot: true, first_name: "SiblingBot" },
    text,
  } as Message;
}

describe("retireTelegramStreamPreviewAcrossAccounts", () => {
  let testState: OpenClawTestState;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "telegram-preview-retirement",
      layout: "state-only",
    });
    cfg = {
      session: { store: testState.statePath("sessions", "sessions.json") },
      channels: {
        telegram: {
          accounts: {
            default: {},
            secondary: {},
          },
        },
      },
    };
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheForTest();
    setTelegramPluginStateRuntimeForTests();
  });

  afterEach(async () => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
    await testState.cleanup();
  });

  // Record and read through the same scope resolution the outbound recorder
  // uses, so a retired key provably matches the key a sibling history stored.
  function cacheFor(accountId: string) {
    return createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(
        resolveStorePath(cfg.session?.store, {
          agentId: resolveTelegramAccountOwnerAgentId({ cfg, accountId }),
        }),
      ),
    });
  }

  it("retires one preview from every account's group history and keeps its neighbors", async () => {
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({
        accountId,
        chatId: groupChatId,
        msg: message(17, "🧠 thinking..."),
        historyEligible: true,
      });
      await cache.record({
        accountId,
        chatId: groupChatId,
        msg: message(18, "regular reply"),
        historyEligible: true,
      });
    }

    await retireTelegramStreamPreviewAcrossAccounts({ cfg, chatId: groupChatId, messageId: 17 });

    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      expect(await cache.get({ accountId, chatId: groupChatId, messageId: "17" })).toBeNull();
      expect(
        (await cache.get({ accountId, chatId: groupChatId, messageId: "18" }))?.messageId,
      ).toBe("18");
      const history = await cache.readHistory({ accountId, chatId: groupChatId, limit: 10 });
      expect(history.messages.map((node) => node.messageId)).toEqual(["18"]);
    }
  });

  it("retires one preview from every account's private-chat cache", async () => {
    const dmChat = { id: 7, type: "private" as const, first_name: "Ada" };
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({ accountId, chatId: 7, msg: message(21, "draft", dmChat) });
      await cache.record({ accountId, chatId: 7, msg: message(22, "final", dmChat) });
    }

    await retireTelegramStreamPreviewAcrossAccounts({ cfg, chatId: 7, messageId: 21 });

    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      expect(await cache.get({ accountId, chatId: 7, messageId: "21" })).toBeNull();
      expect((await cache.get({ accountId, chatId: 7, messageId: "22" }))?.messageId).toBe("22");
    }
  });

  it("covers the implicit default account of a single-account config", async () => {
    cfg = { session: { store: testState.statePath("sessions", "sessions.json") } };
    const cache = cacheFor("default");
    await cache.record({
      accountId: "default",
      chatId: groupChatId,
      msg: message(31, "🧠 thinking..."),
    });

    await retireTelegramStreamPreviewAcrossAccounts({ cfg, chatId: groupChatId, messageId: 31 });

    expect(
      await cache.get({ accountId: "default", chatId: groupChatId, messageId: "31" }),
    ).toBeNull();
  });
});
