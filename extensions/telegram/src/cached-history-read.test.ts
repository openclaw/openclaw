import { randomUUID } from "node:crypto";
import type { Message } from "grammy/types";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCachedTelegramBotInfo } from "./bot-info-cache.js";
import { normalizeTelegramBotInfo } from "./bot-info.js";
import { telegramMessageActions } from "./channel-actions.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";

const state = vi.hoisted(() => ({ sessionStartedAt: 1000 }));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  getSessionEntry: vi.fn(() => ({
    sessionId: "current",
    sessionStartedAt: state.sessionStartedAt,
  })),
  resolveTranscriptSessionKeyBySessionId: vi.fn(() => "agent:main:main"),
}));

const cfg: OpenClawConfig = {
  agents: { entries: { main: { default: true } } },
  channels: {
    telegram: {
      botToken: "99:synthetic-token",
      groupPolicy: "allowlist",
      groupAllowFrom: ["1"],
      groups: { "-1001": {} },
    },
  },
  session: { store: "/synthetic/telegram-cache-read/{agentId}/sessions.json" },
};
function host(): ChannelMessageActionContext {
  return {
    channel: "telegram",
    action: "read",
    cfg,
    params: {},
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    sessionKey: "agent:main:telegram:group:-1001:topic:77",
    sessionId: "current",
    toolContext: {
      currentChannelProvider: "telegram",
      currentChannelId: "telegram:-1001:topic:77",
      currentMessageId: "901",
    },
  };
}
async function readPage(
  params: Record<string, unknown> = {},
  overrides: Partial<ChannelMessageActionContext> = {},
) {
  const result = await telegramMessageActions.handleAction!({ ...host(), ...overrides, params });
  return result.details as {
    messages: Array<{ messageId: string; body?: string; mediaRef?: string; truncated?: true }>;
    nextBefore?: string;
    hasMore: boolean;
  };
}
function message(id: number, extra: Partial<Message> = {}): Message {
  return {
    message_id: id,
    date: 10,
    chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
    message_thread_id: 77,
    is_topic_message: true,
    from: { id: 1, is_bot: false, first_name: "QA" },
    text: `message-${id}`,
    ...extra,
  } as Message;
}
function replyMessage(id: number): NonNullable<Message["reply_to_message"]> {
  const { reply_to_message: _reply, ...rest } = message(id);
  return { ...rest, reply_to_message: undefined };
}
async function record(
  id: number,
  extra: Partial<Message> = {},
  accountId = "default",
  threadId = 77,
) {
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(cfg.session?.store, { agentId: "main" }),
    ),
  });
  // Model the Bot API JSON boundary: absent optional properties are omitted on the wire.
  const wirePayload = JSON.stringify(message(id, extra));
  const wireMessage: Message = JSON.parse(wirePayload);
  await cache.record({
    accountId,
    chatId: -1001,
    msg: wireMessage,
    historyEligible: true,
    providerObservedThread: { scope: "forum", id: threadId },
  });
}

describe("Telegram message.read cached history entrypoint", () => {
  beforeEach(async () => {
    cfg.session!.store = `/synthetic/telegram-cache-read/${randomUUID()}/{agentId}/sessions.json`;
    state.sessionStartedAt = 1000;
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheForTest();
    setTelegramPluginStateRuntimeForTests();
    const botInfo = normalizeTelegramBotInfo({
      id: 99,
      is_bot: true,
      first_name: "Assistant",
      username: "qa_bot",
    });
    if (!botInfo) {
      throw new Error("Invalid test bot identity");
    }
    await writeCachedTelegramBotInfo({
      accountId: "default",
      botToken: "99:synthetic-token",
      botInfo,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
  });

  it("discovers read and pages exclusively by native message ID after cache restart", async () => {
    expect(telegramMessageActions.describeMessageTool?.({ cfg })?.actions).toContain("read");
    for (const id of [897, 898, 899, 900, 901]) {
      await record(id);
    }
    resetTelegramMessageCacheForTest();
    const first = await readPage({ limit: 2 });
    expect(first.messages.map((x) => x.messageId)).toEqual(["899", "900"]);
    expect(first.nextBefore).toBe("899");
    const second = await readPage({ before: first.nextBefore, limit: 2 });
    expect(second.messages.map((x) => x.messageId)).toEqual(["897", "898"]);
  });
  it("has stable exclusive pagination at the exact count ceiling", async () => {
    for (let id = 800; id <= 900; id++) {
      await record(id);
    }
    const page = await readPage({ limit: 100 });
    expect(page.messages).toHaveLength(100);
    expect(page.messages[0]?.messageId).toBe("801");
    expect(page.messages.at(-1)?.messageId).toBe("900");
    expect(page.nextBefore).toBe("801");
    expect(page.hasMore).toBe(true);
    const tail = await readPage({ limit: 100, before: page.nextBefore });
    expect(tail.messages.map((entry) => entry.messageId)).toEqual(["800"]);
    expect(tail.hasMore).toBe(false);
  });

  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { before: 0 },
    { before: 899.5 },
    { threadId: 0 },
  ])("rejects invalid bounds %j", async (params) => {
    await expect(readPage(params)).rejects.toThrow();
  });

  it("uses the ingress allowFrom fallback after a sender is revoked", async () => {
    await record(899, { from: { id: 2, is_bot: false, first_name: "Revoked" } });
    await record(900);
    const currentCfg = structuredClone(cfg);
    delete currentCfg.channels!.telegram!.groupAllowFrom;
    currentCfg.channels!.telegram!.allowFrom = ["1"];
    expect(
      (await readPage({}, { cfg: currentCfg })).messages.map((entry) => entry.messageId),
    ).toEqual(["900"]);
  });

  it("ignores model authority, paths and account props", async () => {
    await record(900);
    await record(899, {}, "work");
    const result = await readPage({
      accountId: "work",
      conversationReadOrigin: "direct-operator",
      requesterAccountId: "work",
      sessionKey: "agent:evil:main",
      storePath: "/private/evil",
      toolContext: { currentChannelId: "-999" },
    });
    expect(result.messages.map((x) => x.messageId)).toEqual(["900"]);
  });
  it.each([
    { sessionKey: undefined },
    { conversationReadOrigin: undefined },
    { requesterAccountId: undefined },
    { requesterAccountId: "work" },
    { toolContext: undefined },
    { toolContext: { currentChannelProvider: "slack", currentChannelId: "-1001" } },
  ] satisfies Partial<ChannelMessageActionContext>[])(
    "rejects missing or mismatched host context %#",
    async (override) => {
      await expect(
        readPage(
          {
            conversationReadOrigin: "direct-operator",
            sessionKey: "forged",
            requesterAccountId: "default",
          },
          override,
        ),
      ).rejects.toThrow();
    },
  );
  it.each([
    { to: "-1002" },
    { to: "-1001:topic:88" },
    { threadId: 88 },
    { before: 902 },
    { to: "-1001:direct-topic:77" },
  ])("rejects cross-conversation request %j", async (params) => {
    await expect(readPage(params)).rejects.toThrow();
  });
  it("excludes denied users, sibling topics/accounts and legacy unbound records", async () => {
    await record(900);
    await record(899, { from: { id: 2, is_bot: false, first_name: "Denied" } });
    await record(898, {}, "default", 88);
    await record(897, {}, "work");
    const result = await readPage();
    expect(result.messages.map((x) => x.messageId)).toEqual(["900"]);
    const deniedCfg = structuredClone(cfg);
    deniedCfg.channels!.telegram!.groupAllowFrom = ["2"];
    expect((await readPage({}, { cfg: deniedCfg })).messages.map((x) => x.messageId)).toEqual([
      "899",
    ]);
  });
  it("retains outbound self replies after startup identity expires without bypassing disabled rooms", async () => {
    await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "default" },
      chatId: -1001,
      messageId: 899,
      botUserId: 99,
      successfulSendThread: { scope: "forum", id: 77 },
      message: {
        message_id: 899,
        date: 10,
        chat: { id: -1001, type: "supergroup" },
        from: { id: 99, is_bot: true, first_name: "Assistant" },
        text: "Bot reply",
        message_thread_id: 77,
      },
    });
    await record(900, { from: { id: 2, is_bot: false, first_name: "Denied" } });
    const local = structuredClone(cfg);
    local.channels!.telegram!.groups = {
      "-1001": { allowFrom: ["1"], topics: { "77": { allowFrom: ["1"] } } },
    };
    expect((await readPage({}, { cfg: local })).messages.map((row) => row.messageId)).toEqual([
      "899",
    ]);
    const nextDay = Date.now() + 25 * 60 * 60 * 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(nextDay);
    expect((await readPage({}, { cfg: local })).messages.map((row) => row.messageId)).toEqual([
      "899",
    ]);
    local.channels!.telegram!.groups["-1001"]!.enabled = false;
    expect((await readPage({}, { cfg: local })).messages).toEqual([]);
    local.channels!.telegram!.groups["-1001"]!.enabled = true;
    local.channels!.telegram!.groupPolicy = "disabled";
    expect((await readPage({}, { cfg: local })).messages).toEqual([]);
  });

  it("reads successful bot replies in an allowlisted private conversation", async () => {
    const local = structuredClone(cfg);
    local.channels!.telegram!.dmPolicy = "allowlist";
    local.channels!.telegram!.allowFrom = ["1"];
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(
        resolveStorePath(local.session?.store, { agentId: "main" }),
      ),
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
        text: "Question",
      },
    });
    await recordOutboundMessageForPromptContext({
      cfg: local,
      account: { accountId: "default" },
      chatId: 1,
      messageId: 900,
      botUserId: 99,
      message: {
        message_id: 900,
        date: 10,
        chat: { id: 1, type: "private" },
        from: { id: 99, is_bot: true, first_name: "Assistant" },
        text: "Answer",
      },
    });
    const conversation = {
      cfg: local,
      sessionKey: "agent:main:telegram:direct:1",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:1",
        currentMessageId: "901",
      },
    };
    expect((await readPage({}, conversation)).messages.map((row) => row.messageId)).toEqual([
      "899",
      "900",
    ]);
    local.channels!.telegram!.dmPolicy = "disabled";
    expect((await readPage({}, conversation)).messages).toEqual([]);
  });
  it.each(["/new", "/reset"])(
    "does not interpret a bot reply containing %s as a reset",
    async (command) => {
      await record(897);
      await record(898, { from: { id: 99, is_bot: true, first_name: "Assistant" }, text: command });
      await record(899);
      expect((await readPage()).messages.map((row) => row.messageId)).toEqual([
        "897",
        "898",
        "899",
      ]);
      expect((await readPage({ before: 898 })).messages.map((row) => row.messageId)).toEqual([
        "897",
      ]);
    },
  );
  it("does not page across reset, while soft reset leaves history intact", async () => {
    await record(897);
    await record(898, { text: "/reset" });
    await record(899);
    await record(900, { text: "/reset soft" });
    expect((await readPage()).messages.map((x) => x.messageId)).toEqual(["899", "900"]);
    expect((await readPage({ before: 898 })).messages).toEqual([]);
  });
  it("applies host sessionStartedAt at Telegram second precision", async () => {
    await record(899, { date: 9 });
    await record(900, { date: 10 });
    state.sessionStartedAt = 10_999;
    expect((await readPage({ sessionStartedAt: 0 })).messages.map((x) => x.messageId)).toEqual([
      "900",
    ]);
  });
  it("does not promote embedded replies to ambient history", async () => {
    await record(900, { reply_to_message: replyMessage(899) });
    expect((await readPage()).messages.map((x) => x.messageId)).toEqual(["900"]);
  });
  it("does not promote an embedded observation when its parent is outside the requested page", async () => {
    await record(901, { reply_to_message: replyMessage(899) });
    expect((await readPage({ before: 900 })).messages).toEqual([]);
  });
  it("does not promote a reply observed through another topic", async () => {
    await record(900, { reply_to_message: replyMessage(899) }, "default", 88);
    expect((await readPage()).messages).toEqual([]);
  });
  it("bounds count and UTF-8 bytes and preserves native media references only", async () => {
    for (let id = 750; id < 900; id++) {
      await record(id);
    }
    expect((await readPage({ limit: 999 })).messages).toHaveLength(100);
    await record(900, {
      text: "😀".repeat(40_000),
      photo: [{ file_id: "native", file_unique_id: "unique", width: 1, height: 1 }],
    });
    const result = await readPage({ limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(result.messages[0]).toMatchObject({
      messageId: "900",
      mediaRef: "telegram:file/native",
      truncated: true,
    });
    expect(result.messages[0]).not.toHaveProperty("sourceMessage");
    expect(result.messages[0]).not.toHaveProperty("resolvedMedia");
  });
});
