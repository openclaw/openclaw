import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramMessageActions } from "./channel-actions.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";

const logicalSessionKey = "agent:main:telegram:default:direct:1";
const persistedSessionKey = "agent:main:main";
const admittedSessionId = "telegram-admitted-session";

describe("Telegram cached reads use the admitted session identity", () => {
  let state: OpenClawTestState;
  let cfg: OpenClawConfig;
  let storePath: string;

  async function persistSession(sessionId: string, sessionStartedAt = 1_000) {
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: persistedSessionKey,
      entry: { sessionId, sessionStartedAt, updatedAt: sessionStartedAt },
    });
  }

  function read(
    overrides: Partial<ChannelMessageActionContext> = {},
    params: Record<string, unknown> = {},
  ) {
    const context: ChannelMessageActionContext = {
      channel: "telegram",
      action: "read",
      cfg,
      params,
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      sessionKey: logicalSessionKey,
      sessionId: admittedSessionId,
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:1",
        currentMessageId: "901",
      },
      ...overrides,
    };
    return telegramMessageActions.handleAction!(context);
  }

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    state = await createOpenClawTestState({ label: "telegram-read-session", layout: "state-only" });
    resetTelegramMessageCacheForTest();
    setTelegramPluginStateRuntimeForTests();
    storePath = resolveStorePath(undefined, { agentId: "main" });
    cfg = {
      agents: { entries: { main: { default: true } } },
      session: { store: storePath },
      channels: {
        telegram: {
          botToken: "99:synthetic-token",
          dmPolicy: "allowlist",
          allowFrom: ["1"],
        },
      },
    };
    await persistSession(admittedSessionId);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: 1,
      historyEligible: true,
      msg: {
        message_id: 899,
        date: 10,
        chat: { id: 1, type: "private", first_name: "User" },
        from: { id: 1, is_bot: false, first_name: "User" },
        text: "When is the release?",
      },
    });
    await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "default" },
      chatId: 1,
      messageId: 900,
      botUserId: 99,
      message: {
        message_id: 900,
        date: 10,
        chat: { id: 1, type: "private" },
        from: { id: 99, is_bot: true, first_name: "Assistant" },
        text: "The release is on Friday.",
      },
    });
  });

  afterEach(async () => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it("reads the main DM session through its logical Telegram key", async () => {
    expect(getSessionEntry({ sessionKey: logicalSessionKey, storePath })).toBeUndefined();
    expect((await read()).details).toMatchObject({
      messages: [
        { messageId: "899", body: "When is the release?" },
        { messageId: "900", body: "The release is on Friday." },
      ],
    });
  });

  it("rejects the retired admitted identity after the persisted session resets", async () => {
    const context = { sessionKey: persistedSessionKey };
    expect((await read(context)).details).toMatchObject({
      messages: [{ messageId: "899" }, { messageId: "900" }],
    });
    await persistSession("telegram-replacement-session", 20_000);
    await expect(read(context)).rejects.toThrow(/current host session/i);
    expect(
      (await read({ ...context, sessionId: "telegram-replacement-session" })).details,
    ).toMatchObject({ messages: [] });
  });

  it("does not accept a model-supplied session ID in place of host identity", async () => {
    await expect(
      read(
        { sessionKey: persistedSessionKey, sessionId: undefined },
        { sessionId: admittedSessionId },
      ),
    ).rejects.toThrow(/current host session/i);
  });
});
