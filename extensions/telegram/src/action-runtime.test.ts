import path from "node:path";
import type { Message } from "grammy/types";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import {
  isTelegramMessageCacheSourceMessage,
  resolveTelegramMessageCacheScope,
} from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("Telegram registered action authority and input contracts", () => {
  const fixture = useTelegramHttpFixture();
  const { requests, endpoints, rejections } = fixture;
  let state: OpenClawTestState;
  let env = captureEnv([]);
  let cfg: OpenClawConfig;
  const trusted = {
    conversationReadOrigin: "delegated" as const,
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "telegram" as const,
      currentChannelId: "telegram:-1001:topic:77",
      currentMessageId: "456",
    },
  };
  const invoke = (
    action: ChannelMessageActionContext["action"],
    params: Record<string, unknown>,
    context: Partial<ChannelMessageActionContext> = {},
  ) =>
    telegramPlugin.actions!.handleAction!({
      channel: "telegram",
      action,
      params,
      cfg,
      conversationReadOrigin: "direct-operator",
      ...context,
    });

  beforeEach(async () => {
    env = captureEnv(["TELEGRAM_BOT_TOKEN"]);
    delete process.env.TELEGRAM_BOT_TOKEN;
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "telegram-actions-http-",
    });
    cfg = {
      ...fixture.cfg,
      channels: { telegram: { ...fixture.cfg.channels.telegram, reactionLevel: "minimal" } },
      session: { store: path.join(state.stateDir, "{agentId}", "sessions.json") },
    };
    resetTelegramMessageCacheForTest();
    setTelegramPluginStateRuntimeForTests();
  });
  afterEach(async () => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    env.restore();
    await state.cleanup();
  });

  it("requires host-owned current-message authority for reactions, edits and deletes", async () => {
    const params = {
      chatId: "telegram:-1001:topic:77",
      messageId: 456,
      emoji: "👍",
      message: "updated",
    };
    for (const action of ["react", "edit", "delete"] as const) {
      const denied = invoke(
        action,
        {
          ...params,
          conversationReadOrigin: "direct-operator",
          requesterAccountId: "default",
          toolContext: trusted.toolContext,
        },
        { ...trusted, toolContext: { ...trusted.toolContext, currentMessageId: "999" } },
      );
      if (action === "react") {
        await expect(denied).resolves.toMatchObject({ details: { ok: false, reason: "error" } });
      } else {
        await expect(denied).rejects.toThrow(/provider-observed binding/);
      }
    }
    expect(requests).toEqual([]);
    for (const action of ["react", "edit", "delete"] as const) {
      await invoke(action, params, trusted);
    }
    expect(
      requests.map(({ method, fields }) => [method, fields.chat_id, fields.message_id]),
    ).toEqual([
      ["setMessageReaction", "-1001", 456],
      ["editMessageText", "-1001", 456],
      ["deleteMessage", "-1001", 456],
    ]);
    rejections.push("Bad Request: message can't be deleted");
    const refused = await invoke("delete", params, trusted);
    expect(refused.details).toMatchObject({
      ok: false,
      deleted: false,
      warning: expect.stringContaining("message can't be deleted"),
    });
  });

  it("projects a provider-confirmed absent delete as deleted", async () => {
    const params = { chatId: "-1001:topic:77", messageId: 456 };
    rejections.push("Bad Request: message to delete not found");
    const absent = await invoke("delete", params, trusted);
    expect(absent.details).toMatchObject({ ok: true, deleted: true });
  });

  it("treats a lost delete response as deleted once the retry confirms absence", async () => {
    const params = { chatId: "-1001:topic:77", messageId: 456 };
    // First attempt: the provider applies the delete but the response is lost.
    // Retry: the provider confirms the message is already gone.
    rejections.push({ resetConnection: true }, "Bad Request: message to delete not found");
    const settled = await invoke("delete", params, trusted);
    expect(settled.details).toMatchObject({ ok: true, deleted: true });
    expect(requests.filter(({ method }) => method === "deleteMessage")).toHaveLength(2);
  });

  it.each(["77", "1"])(
    "binds a topicless reaction to trusted topic %s without borrowing another chat",
    async (thread) => {
      const context = {
        ...trusted,
        toolContext: {
          ...trusted.toolContext,
          currentChannelId: "telegram:-1001",
          currentThreadTs: thread,
        },
      };
      await expect(
        invoke("react", { chatId: "-1002", emoji: "👍" }, context),
      ).resolves.toMatchObject({ details: { ok: false, reason: "error" } });
      expect(requests).toEqual([]);
      await invoke("react", { chatId: "-1001", emoji: "👍" }, context);
      expect(requests).toEqual([
        {
          method: "setMessageReaction",
          fields: { chat_id: "-1001", message_id: 456, reaction: [{ type: "emoji", emoji: "👍" }] },
        },
      ]);
    },
  );

  it("rejects conflicting host authority, including threadless and missing-origin invocations", async () => {
    const params = { chatId: "-1001:topic:77", messageId: 456 };
    const contexts: Partial<ChannelMessageActionContext>[] = [
      { ...trusted, requesterAccountId: "other" },
      { ...trusted, requesterAccountId: " !!! " },
      { ...trusted, toolContext: { ...trusted.toolContext, currentChannelProvider: "slack" } },
      { ...trusted, toolContext: { ...trusted.toolContext, currentThreadTs: "88" } },
      {
        ...trusted,
        toolContext: { ...trusted.toolContext, currentMessagingTarget: "-1002:topic:77" },
      },
      { conversationReadOrigin: undefined },
    ];
    for (const context of contexts) {
      await expect(invoke("delete", params, context)).rejects.toThrow(/provider-observed binding/);
    }
    await expect(
      invoke(
        "delete",
        { chatId: "-1002", messageId: 456 },
        {
          ...trusted,
          toolContext: { ...trusted.toolContext, currentChannelId: "telegram:-1001" },
        },
      ),
    ).rejects.toThrow(/provider-observed binding/);
    expect(requests).toEqual([]);
    await invoke("delete", params, trusted);
    expect(requests.map(({ method }) => method)).toEqual(["deleteMessage"]);
  });

  it("retains account- and topic-bound historical authority after the cache restarts", async () => {
    cfg.channels!.telegram!.accounts = { work: { botToken: "654321:other-account" } };
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(
        resolveStorePath(cfg.session?.store, { agentId: "main" }),
      ),
    });
    const message = (id: number, thread: number) =>
      ({
        message_id: id,
        message_thread_id: thread,
        is_topic_message: true,
        date: 1_736_380_700,
        chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
        text: "historical context",
        from: { id: 1, is_bot: false, first_name: "QA" },
      }) satisfies Message.TextMessage;
    for (const [id, thread, observed] of [
      [900, 77, true],
      [898, 77, false],
      [897, 88, true],
    ] as const) {
      const msg: unknown = {
        ...message(id, thread),
        ...(id === 900 ? { reply_to_message: message(899, 77) } : {}),
      };
      if (!isTelegramMessageCacheSourceMessage(msg)) {
        throw new Error("Invalid Telegram cache source fixture");
      }
      await cache.record({
        accountId: "default",
        chatId: -1001,
        msg,
        threadId: thread,
        ...(observed ? { providerObservedThread: { scope: "forum" as const, id: thread } } : {}),
      });
    }
    resetTelegramMessageCacheForTest();
    const mutate = (messageId: number, accountId = "default") =>
      invoke(
        "delete",
        { chatId: "-1001:topic:77", messageId },
        {
          ...trusted,
          accountId,
          requesterAccountId: accountId,
        },
      );
    await mutate(900);
    await mutate(899);
    await expect(mutate(898)).rejects.toThrow(/provider-observed binding/);
    await expect(mutate(897)).rejects.toThrow(/provider-observed binding/);
    await expect(mutate(900, "work")).rejects.toThrow(/provider-observed binding/);
    expect(requests.map(({ fields }) => fields.message_id)).toEqual([900, 899]);
  });

  it("reads a routed account owner's persisted send observation after restart", async () => {
    cfg.agents = { ownership: "explicit", entries: { main: {}, ops: {}, research: {} } };
    cfg.channels!.telegram!.accounts = { alerts: { botToken: "654321:routed-alerts" } };
    cfg.bindings = [{ agentId: "ops", match: { channel: "telegram", accountId: "alerts" } }];
    await recordOutboundMessageForPromptContext({
      cfg,
      account: { accountId: "alerts", name: "Alerts" },
      chatId: -1001,
      messageId: 902,
      message: {
        message_id: 902,
        message_thread_id: 77,
        date: 1_736_380_700,
        chat: { id: -1001, type: "supergroup", title: "QA" },
        text: "earlier reply",
      },
      successfulSendThread: { scope: "forum", id: 77 },
    });
    resetTelegramMessageCacheForTest();
    await invoke(
      "delete",
      { chatId: "-1001:topic:77", messageId: 902 },
      { ...trusted, accountId: "alerts", requesterAccountId: "alerts" },
    );
    expect(endpoints).toEqual(["/bot654321:routed-alerts/deleteMessage"]);
    expect(requests[0]!.fields).toEqual({ chat_id: "-1001", message_id: 902 });
  });

  it("keeps direct operator bypass local to its concurrent operation", async () => {
    const params = { chatId: "-1001:topic:77", messageId: 800 };
    const outcomes = await Promise.allSettled([
      invoke("delete", params),
      invoke("delete", params, trusted),
    ]);
    expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
    expect(requests.map(({ fields }) => fields.message_id)).toEqual([800]);
  });

  it("uses the configured default account for reaction permission and the actual endpoint", async () => {
    cfg.channels!.telegram = {
      ...fixture.cfg.channels.telegram,
      defaultAccount: "kitt",
      reactionLevel: "minimal",
      actions: { reactions: false },
      accounts: { kitt: { botToken: "654321:default-kitt", actions: { reactions: true } } },
    };
    await invoke("react", { chatId: "123", messageId: 456, emoji: "👍" });
    expect(endpoints).toEqual(["/bot654321:default-kitt/setMessageReaction"]);
  });

  it("bounds rejected-reaction guidance while preferring portable alternatives", async () => {
    rejections.push("Bad Request: REACTION_INVALID");
    fixture.responseFor = (method) =>
      method === "getChat"
        ? {
            id: 123,
            type: "private",
            first_name: "Fixture",
            available_reactions: [
              ...Array.from({ length: 25 }, (_, index) => ({
                type: "custom_emoji",
                custom_emoji_id: String(9000 + index),
              })),
              { type: "emoji", emoji: "👍" },
            ],
          }
        : undefined;
    const result = await invoke("react", { chatId: "123", messageId: 456, emoji: "✅" });
    expect(result.details).toMatchObject({ ok: false });
    const details = JSON.stringify(result.details);
    expect(details).toContain("👍");
    expect(details).toContain("9018");
    expect(details).not.toContain("9019");
    expect(requests.map(({ method }) => method)).toEqual(["setMessageReaction", "getChat"]);
  });

  it.each([false, true])(
    "distinguishes unrestricted reactions from failed discovery (failed: %s)",
    async (failed) => {
      rejections.push(
        "Bad Request: REACTION_INVALID",
        ...(failed ? ["Bad Request: chat not found"] : []),
      );
      const result = await invoke("react", { chatId: "123", messageId: 456, emoji: "✅" });
      expect(result.details).toMatchObject({ ok: false });
      expect(JSON.stringify(result.details).includes("This chat allows:")).toBe(!failed);
    },
  );

  it("discovers only the delegated current chat and bounds provider reaction lists", async () => {
    fixture.responseFor = () => ({
      id: -1001,
      type: "supergroup",
      title: "Fixture",
      available_reactions: [
        { type: "emoji", emoji: "👍" },
        ...Array.from({ length: 120 }, (_, index) => ({
          type: "custom_emoji",
          custom_emoji_id: String(9000 + index),
        })),
      ],
    });
    for (const context of [
      { ...trusted, requesterAccountId: "other" },
      { ...trusted, toolContext: { ...trusted.toolContext, currentChannelProvider: "discord" } },
    ]) {
      await expect(invoke("emoji-list", {}, context)).rejects.toThrow(
        /exact current chat and account/,
      );
    }
    await expect(invoke("emoji-list", { chatId: "-1002" }, trusted)).rejects.toThrow(
      /exact current chat and account/,
    );
    expect(requests).toEqual([]);
    await expect(invoke("emoji-list", { limit: 2 }, trusted)).resolves.toMatchObject({
      details: {
        ok: true,
        emojis: [
          { name: "👍", identifier: "👍" },
          { identifier: "9000", type: "custom_emoji" },
        ],
      },
    });
    const capped = await invoke("emoji-list", { chatId: "-1002", limit: 200 });
    expect(capped.details).toMatchObject({
      emojis: expect.arrayContaining([{ identifier: "9098", type: "custom_emoji" }]),
    });
    expect(JSON.stringify(capped.details)).not.toContain("9099");
    expect(requests.map(({ fields }) => fields.chat_id)).toEqual(["-1001", "-1002"]);
  });

  it.each([
    { action: "send", params: { to: "123" }, error: /content required/i },
    {
      action: "send",
      params: { to: "123", message: "hello", replyToMessageId: 9.5 },
      error: /positive integer/,
    },
    {
      action: "sticker",
      params: { to: "123", fileId: "sticker", threadId: 11.5 },
      error: /positive integer/,
    },
    { action: "delete", params: { chatId: "123", messageId: 456.5 }, error: /positive integer/ },
    {
      action: "edit",
      params: { chatId: "123", messageId: 456.5, message: "updated" },
      error: /positive integer/,
    },
    {
      action: "poll",
      params: { to: "123", question: "Ready?", answers: ["Yes", "No"], durationSeconds: 60.5 },
      error: /positive integer/,
    },
    {
      action: "poll",
      params: {
        to: "123",
        question: "Ready?",
        answers: ["Yes", "No"],
        pollAnonymous: true,
        pollPublic: true,
      },
      error: /mutually exclusive/i,
    },
    {
      action: "send",
      params: { to: "123", message: "caption", location: { latitude: 1, longitude: 2 } },
      error: /cannot be combined/,
    },
    {
      action: "send",
      params: {
        to: "123",
        location: { latitude: 1, longitude: 2 },
        presentation: { blocks: [{ type: "text", text: "caption" }] },
      },
      error: /cannot be combined/,
    },
    {
      action: "send",
      params: { to: "123", message: "choose", buttons: '[[{"text":"Yes","callback_data":"yes"}]]' },
      error: /native "buttons" is unsupported/,
    },
  ] as const)(
    "rejects invalid external $action input before network delivery: $error",
    async ({ action, params, error }) => {
      cfg.channels!.telegram!.actions = { sticker: true };
      await expect(invoke(action, params)).rejects.toThrow(error);
      expect(requests).toEqual([]);
    },
  );

  it("preserves structured missing-topic-name validation", async () => {
    cfg.channels!.telegram!.actions = { createForumTopic: true };
    await expect(invoke("topic-create", { chatId: "123" })).rejects.toMatchObject({
      name: "ToolInputError",
      status: 400,
    });
    expect(requests).toEqual([]);
  });

  it.each([undefined, 456.5])("soft-fails invalid reaction message ids (%s)", async (messageId) => {
    await expect(invoke("react", { chatId: "123", messageId, emoji: "👍" })).resolves.toMatchObject(
      { details: { ok: false, reason: "missing_message_id" } },
    );
    expect(requests).toEqual([]);
  });

  it.each(["off", "ack", "action"] as const)(
    "soft-fails reactions disabled by %s policy",
    async (policy) => {
      cfg.channels!.telegram = {
        ...fixture.cfg.channels.telegram,
        reactionLevel: policy === "action" ? "minimal" : policy,
        actions: { reactions: policy !== "action" },
      };
      await expect(
        invoke("react", { chatId: "123", messageId: 456, emoji: "👍" }),
      ).resolves.toMatchObject({ details: { ok: false, reason: "disabled" } });
      expect(requests).toEqual([]);
    },
  );

  it.each([
    { action: "send", params: { to: "123", message: "hello" }, gate: "sendMessage" },
    {
      action: "poll",
      params: { to: "123", question: "Ready?", answers: ["Yes", "No"] },
      gate: "poll",
    },
    { action: "delete", params: { chatId: "123", messageId: 456 }, gate: "deleteMessage" },
    { action: "emoji-list", params: { chatId: "123" }, gate: "reactions" },
    { action: "sticker", params: { to: "123", fileId: "sticker" }, gate: "sticker" },
  ] as const)(
    "enforces registered $action gates before provider execution",
    async ({ action, params, gate }) => {
      cfg.channels!.telegram!.actions = { [gate]: false };
      await expect(invoke(action, params)).rejects.toThrow(/disabled/i);
      expect(requests).toEqual([]);
    },
  );

  it.each(["off", "dm"] as const)(
    "enforces inline-button %s scope before sending to groups",
    async (scope) => {
      cfg.channels!.telegram!.capabilities = { inlineButtons: scope };
      await expect(
        invoke("send", {
          to: "-1001",
          message: "Choose",
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "env|prod" }] }],
          },
        }),
      ).rejects.toThrow(/inline buttons/);
      expect(requests).toEqual([]);
    },
  );

  it("rejects sending without a configured credential", async () => {
    cfg = {};
    await expect(invoke("send", { to: "123", message: "hello" })).rejects.toThrow(
      /bot token missing/,
    );
    expect(requests).toEqual([]);
  });
});
