import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasProviderObservedTelegramThreadBinding } from "./message-cache-codec.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
} from "./runtime.test-support.js";

let cfg: OpenClawConfig;
let testState: OpenClawTestState;
const account = { accountId: "default", name: "Configured Agent" };
const bot = (first_name: string, username?: string) => ({
  id: 999,
  is_bot: true,
  first_name,
  ...(username ? { username } : {}),
});
const privateChat = { id: 42, type: "private" };
const self = (sender: string, senderId = "999", extra = {}) => ({
  sender: `${sender} (you)`,
  senderId,
  ...extra,
});
type RecordParams = Omit<Parameters<typeof recordOutboundMessageForPromptContext>[0], "cfg">;
function providerMessage(messageId: number, overrides: Partial<RecordParams["message"]> = {}) {
  return {
    chat: { id: -1001, type: "supergroup", title: "QA" },
    date: 1_736_380_700,
    from: bot("OpenClaw"),
    message_id: messageId,
    text: "Bot just replied",
    ...overrides,
  };
}

async function recordAndRead(params: Partial<RecordParams> & Pick<RecordParams, "messageId">) {
  const input = { account, chatId: 42, message: { message_id: params.messageId }, ...params };
  await recordOutboundMessageForPromptContext({ cfg, ...input });
  const cache = createPromptContextCache();
  return await cache.get({
    accountId: input.account.accountId,
    chatId: input.chatId,
    messageId: String(params.messageId),
  });
}

function createPromptContextCache() {
  return createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(resolveStorePath(cfg.session?.store)),
  });
}

describe("recordOutboundMessageForPromptContext", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "telegram-outbound-history",
      layout: "state-only",
    });
    cfg = { session: { store: testState.statePath("sessions", "sessions.json") } };
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheBucketsForTest();
    setTelegramPluginStateRuntimeForTests();
  });

  afterEach(async () => {
    clearTelegramRuntime();
    resetTelegramMessageCacheBucketsForTest();
    resetPluginStateStoreForTests();
    await testState.cleanup();
  });

  it("uses the configured self name and drops stale Telegram display-name fields", async () => {
    const cached = await recordAndRead({
      account: { accountId: "default", name: "  Configured Agent  " },
      message: providerMessage(700, {
        chat: privateChat,
        from: { ...bot("Provisioning", "openclaw_bot"), last_name: "Placeholder" },
      }),
      messageId: 700,
    });

    expect(cached).toMatchObject(
      self("Configured Agent", "999", {
        senderUsername: "openclaw_bot",
        sourceMessage: { from: bot("Configured Agent (you)", "openclaw_bot") },
      }),
    );
    expect(cached?.sourceMessage.from).not.toHaveProperty("last_name");
  });

  it("binds topics only when the successful provider response identifies the thread", async () => {
    const common = {
      chatId: -1001,
      messageId: 700,
      text: "Bot just replied",
      messageThreadId: 77,
      successfulSendThread: { id: 77, scope: "forum" },
    } as const;
    const callerOnlyThread = await recordAndRead({ ...common, message: providerMessage(700) });
    expect(hasProviderObservedTelegramThreadBinding(callerOnlyThread, 77)).toBe(false);

    const providerThread = await recordAndRead({
      ...common,
      messageId: 701,
      message: providerMessage(701, {
        message_thread_id: 77,
      }),
    });
    expect(hasProviderObservedTelegramThreadBinding(providerThread, 77)).toBe(true);
  });

  it("records the successful channel Direct Messages spec ahead of raw message_thread_id", async () => {
    const cached = await recordAndRead({
      chatId: -1002,
      messageId: 704,
      messageThreadId: 999,
      successfulSendThread: { id: 77, scope: "direct-messages" },
      message: providerMessage(704, {
        chat: { id: -1002, type: "supergroup" },
        message_thread_id: 999,
        direct_messages_topic: { topic_id: 77 },
      }),
    });

    expect([cached?.threadId, cached?.threadBinding?.threadSpec]).toEqual([
      "77",
      { scope: "direct-messages", id: 77 },
    ]);
  });

  it("does not infer a General-topic binding for DM thread context", async () => {
    const cached = await recordAndRead({
      message: providerMessage(703, { chat: privateChat }),
      messageId: 703,
      messageThreadId: 1,
      successfulSendThread: { id: 1, scope: "dm" },
    });
    expect(hasProviderObservedTelegramThreadBinding(cached, 1)).toBe(false);
  });

  it.each([
    {
      name: "Telegram bot name when unconfigured",
      accountName: "",
      message: providerMessage(701, {
        from: bot("Atlas", "atlas_bot"),
      }),
      expected: self("Atlas", "999", { senderUsername: "atlas_bot" }),
    },
    {
      name: "Telegram Business sender",
      accountName: "Configured Agent",
      message: providerMessage(702, {
        from: {
          id: 777,
          is_bot: false,
          first_name: "Business Account",
          username: "business_account",
        },
        sender_business_bot: bot("Telegram Bot Name", "openclaw_bot"),
      }),
      expected: self("Configured Agent", "777", {
        senderUsername: "business_account",
        sourceMessage: { sender_business_bot: { id: 999, is_bot: true, username: "openclaw_bot" } },
      }),
    },
    {
      name: "synthetic sender for a finalized stream without from",
      accountName: "StreamBot",
      message: { message_id: 1497 },
      expected: self("StreamBot", "0", {
        sourceMessage: { from: { id: 0, is_bot: true, first_name: "StreamBot (you)" } },
      }),
    },
  ])("preserves the $name identity", async ({ accountName, message, expected }) => {
    expect(
      await recordAndRead({
        account: { accountId: "default", name: accountName },
        message: { ...message, chat: privateChat },
        messageId: message.message_id,
        text: "Bot just replied",
      }),
    ).toMatchObject(expected);
  });

  it("ignores Telegram's fake sender identity across channel post echoes", async () => {
    const echo = {
      message_id: 1498,
      from: { id: 777_000, is_bot: false, first_name: "Telegram" },
      sender_chat: { id: -1001, title: "Announcements" },
      text: "Channel announcement",
    };
    const initial = await recordAndRead({
      account: { accountId: "default" },
      chatId: -1001,
      message: { message_id: echo.message_id, from: echo.from, sender_chat: echo.sender_chat },
      messageId: 1498,
      text: "Channel announcement",
    });
    expect(initial).toMatchObject(self("OpenClaw", "0"));

    const cache = createPromptContextCache();
    await cache.record({
      accountId: "default",
      chatId: -1001,
      msg: {
        ...echo,
        date: 1_736_380_900,
        chat: { id: -1001, type: "supergroup", title: "Announcements" },
        sender_chat: { id: -1001, type: "channel", title: "Announcements" },
      },
    });

    const merged = await cache.get({ accountId: "default", chatId: -1001, messageId: "1498" });
    expect(merged).toMatchObject(
      self("OpenClaw", "0", {
        sourceMessage: {
          from: { id: 0, is_bot: true, first_name: "OpenClaw (you)" },
          sender_chat: { id: -1001, type: "channel", title: "Announcements" },
        },
      }),
    );
  });
});
