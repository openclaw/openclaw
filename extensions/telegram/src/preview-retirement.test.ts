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

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: groupChatId,
      messageId: 17,
      chatType: "supergroup",
    });

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

  it("retires only in the originating account for private chats, whose message ids are account-local", async () => {
    const dmChat = { id: 7, type: "private" as const, first_name: "Ada" };
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({ accountId, chatId: 7, msg: message(21, "draft", dmChat) });
      await cache.record({ accountId, chatId: 7, msg: message(22, "final", dmChat) });
    }

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: 7,
      messageId: 21,
      chatType: "private",
    });

    const origin = cacheFor("default");
    expect(await origin.get({ accountId: "default", chatId: 7, messageId: "21" })).toBeNull();
    expect(
      (await origin.get({ accountId: "default", chatId: 7, messageId: "22" }))?.messageId,
    ).toBe("22");
    // Bot B's message 21 is its own account-local record, not bot A's deleted
    // preview; numeric coordinates must not cross private-chat boundaries.
    const sibling = cacheFor("secondary");
    expect(
      (await sibling.get({ accountId: "secondary", chatId: 7, messageId: "21" }))?.messageId,
    ).toBe("21");
    expect(
      (await sibling.get({ accountId: "secondary", chatId: 7, messageId: "22" }))?.messageId,
    ).toBe("22");
  });

  it("keeps basic-group retirement account-local for the same identity reason", async () => {
    // Basic-group ids are negative without the shared `-100…` supergroup space.
    const basicGroupChat = { id: -445566, type: "group" as const, title: "Basic" };
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({
        accountId,
        chatId: -445566,
        msg: message(9, "draft", basicGroupChat),
        historyEligible: true,
      });
    }

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "secondary",
      chatId: -445566,
      messageId: 9,
      chatType: "group",
    });

    expect(
      await cacheFor("secondary").get({ accountId: "secondary", chatId: -445566, messageId: "9" }),
    ).toBeNull();
    expect(
      (await cacheFor("default").get({ accountId: "default", chatId: -445566, messageId: "9" }))
        ?.messageId,
    ).toBe("9");
  });

  it("keeps basic-group retirement account-local even when the id sits in the -100 space", async () => {
    // Telegram recycles basic-group ids into the -100… space over time, so
    // the id prefix cannot prove shared identity; only the chat type can.
    const basicGroupChat = { id: -100123, type: "group" as const, title: "Recycled" };
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({
        accountId,
        chatId: -100123,
        msg: message(11, "draft", basicGroupChat),
        historyEligible: true,
      });
    }

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "secondary",
      chatId: -100123,
      messageId: 11,
      chatType: "group",
    });

    expect(
      await cacheFor("secondary").get({ accountId: "secondary", chatId: -100123, messageId: "11" }),
    ).toBeNull();
    expect(
      (await cacheFor("default").get({ accountId: "default", chatId: -100123, messageId: "11" }))
        ?.messageId,
    ).toBe("11");
  });

  it("fans out for a channel post, whose message ids are the channel sequence", async () => {
    const channelChat = { id: -100998, type: "channel" as const, title: "News" };
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({
        accountId,
        chatId: -100998,
        msg: message(13, "draft", channelChat),
        historyEligible: true,
      });
    }

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: -100998,
      messageId: 13,
      chatType: "channel",
    });

    for (const accountId of ["default", "secondary"]) {
      expect(
        await cacheFor(accountId).get({ accountId, chatId: -100998, messageId: "13" }),
      ).toBeNull();
    }
  });

  it("stays account-local when the chat type is unknown", async () => {
    for (const accountId of ["default", "secondary"]) {
      const cache = cacheFor(accountId);
      await cache.record({
        accountId,
        chatId: groupChatId,
        msg: message(15, "draft"),
        historyEligible: true,
      });
    }

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: groupChatId,
      messageId: 15,
    });

    expect(
      await cacheFor("default").get({ accountId: "default", chatId: groupChatId, messageId: "15" }),
    ).toBeNull();
    expect(
      (
        await cacheFor("secondary").get({
          accountId: "secondary",
          chatId: groupChatId,
          messageId: "15",
        })
      )?.messageId,
    ).toBe("15");
  });

  it("covers the implicit default account of a single-account config", async () => {
    cfg = { session: { store: testState.statePath("sessions", "sessions.json") } };
    const cache = cacheFor("default");
    await cache.record({
      accountId: "default",
      chatId: groupChatId,
      msg: message(31, "🧠 thinking..."),
    });

    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: groupChatId,
      messageId: 31,
      chatType: "supergroup",
    });

    expect(
      await cache.get({ accountId: "default", chatId: groupChatId, messageId: "31" }),
    ).toBeNull();
  });

  it("fences a sibling's late observation of an already-retired preview", async () => {
    const sibling = cacheFor("secondary");
    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: groupChatId,
      messageId: 41,
      chatType: "supergroup",
    });

    // The sibling's ingress delivers the preview only after retirement ran.
    await sibling.record({
      accountId: "secondary",
      chatId: groupChatId,
      msg: message(41, "🧠 thinking..."),
      historyEligible: true,
    });

    expect(
      await sibling.get({ accountId: "secondary", chatId: groupChatId, messageId: "41" }),
    ).toBeNull();
    const history = await sibling.readHistory({
      accountId: "secondary",
      chatId: groupChatId,
      limit: 10,
    });
    expect(history.messages.map((node) => node.messageId)).toEqual([]);
  });

  it("fences a replayed observation after the bucket is reopened", async () => {
    await cacheFor("secondary").record({
      accountId: "secondary",
      chatId: groupChatId,
      msg: message(42, "🧠 thinking..."),
      historyEligible: true,
    });
    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: groupChatId,
      messageId: 42,
      chatType: "supergroup",
    });

    // Reopen the in-memory bucket over the same state dir; the retirement
    // marker must survive so a durable-ingress replay cannot reinsert 42.
    resetTelegramMessageCacheForTest();
    const reopened = cacheFor("secondary");
    await reopened.record({
      accountId: "secondary",
      chatId: groupChatId,
      msg: message(42, "🧠 thinking..."),
      historyEligible: true,
    });

    expect(
      await reopened.get({ accountId: "secondary", chatId: groupChatId, messageId: "42" }),
    ).toBeNull();
  });

  it("still records the final message that shares the chat but not the preview id", async () => {
    await cacheFor("secondary").record({
      accountId: "secondary",
      chatId: groupChatId,
      msg: message(51, "🧠 thinking..."),
      historyEligible: true,
    });
    await retireTelegramStreamPreviewAcrossAccounts({
      cfg,
      originAccountId: "default",
      chatId: groupChatId,
      messageId: 51,
      chatType: "supergroup",
    });

    const reopened = cacheFor("secondary");
    await reopened.record({
      accountId: "secondary",
      chatId: groupChatId,
      msg: message(52, "final answer"),
      historyEligible: true,
    });

    expect(
      (await reopened.get({ accountId: "secondary", chatId: groupChatId, messageId: "52" }))
        ?.messageId,
    ).toBe("52");
  });
});
