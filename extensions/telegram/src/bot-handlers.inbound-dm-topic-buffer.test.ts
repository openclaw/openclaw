// Drives the real Telegram inbound debounce path, not only key construction.
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";
import { buildTelegramInboundDebounceConversationKey } from "./bot-handlers.debounce-key.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramInboundPipeline } from "./bot-handlers.inbound-pipeline.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramMessageProcessingResult } from "./bot-processing-outcome.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramMessageThreadSpec, type TelegramThreadSpec } from "./bot/helpers.js";

const CHAT_ID = 7;
const SENDER_ID = "42";

function textMessage(messageId: number, text: string, threadId?: number): Message {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: { id: CHAT_ID, type: "private", first_name: "Ada" },
    from: { id: 42, is_bot: false, first_name: "Ada" },
    text,
    ...(threadId == null ? {} : { message_thread_id: threadId }),
  } as Message;
}

function inboundContext(message: Message, updateId: number): Context {
  return {
    message,
    update: { update_id: updateId, message },
    me: telegramBotInfoForTest,
    getFile: async () => {
      throw new Error("text messages do not download files");
    },
  } as Context;
}

describe("private DM topic inbound debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps two private topics in separate buffers and still coalesces a non-topic DM", async () => {
    vi.useFakeTimers();
    const cfg = {
      messages: { inbound: { debounceMs: 40 } },
    } as OpenClawConfig;
    const flushed: Array<{ text: string | undefined; thread: TelegramThreadSpec | undefined }> = [];
    const processMessageWithReplyChain: TelegramMessagePipeline["processMessageWithReplyChain"] =
      async (entry) => {
        flushed.push({ text: entry.msg.text, thread: entry.options?.threadSpec });
        return { kind: "completed" } satisfies TelegramMessageProcessingResult;
      };
    const message = {
      resolveMediaRuntime: () => ({ token: "test-token" }),
      recordMessageResolvedMedia: async () => undefined,
      mergeDispatchDedupeClaims: () => [],
      releaseDispatchDedupeClaims: () => undefined,
      settleSpooledReplayParticipants: () => undefined,
      resolveTelegramSessionState: async () => ({
        agentId: "test",
        bindingMode: { kind: "none" as const },
        sessionEntry: undefined,
        sessionKey: "test",
        storePath: "test",
        model: undefined,
      }),
      resolvePromptContextAmbientWatermark: async () => undefined,
      claimMessageDispatchDedupe: async () => ({ process: true, claims: [] }),
      recordMessageForReplyChain: async (msg: Message) => ({
        messageId: String(msg.message_id),
        sender: "Ada",
        sourceMessage: msg,
      }),
      processMessageWithReplyChain,
    } as unknown as TelegramMessagePipeline;
    const allow = normalizeAllowFrom([SENDER_ID]);
    const emptyAllow = normalizeAllowFrom();
    const authorizeInboundMessage = async (inbound: { msg: Message; isForum: boolean }) => ({
      allowed: true,
      effectiveDmAllow: allow,
      resolveChannelIngress: async () => {
        throw new Error("debounce buffering does not resolve ingress");
      },
      context: {
        cfg,
        commandAuthorizedByConfig: false,
        allowFrom: [],
        telegramCfg: {},
        dmPolicy: "open",
        resolvedThreadId: undefined,
        storeAllowFrom: [],
        groupConfig: undefined,
        topicConfig: undefined,
        effectiveGroupAllow: emptyAllow,
        hasGroupAllowOverride: false,
        threadSpec: resolveTelegramMessageThreadSpec(inbound.msg, inbound.isForum),
      },
    });
    const params = {
      cfg,
      accountId: "default",
      ownerAgentId: "main",
      bot: {
        api: {
          getChat: async () => {
            throw new Error("private text debounce does not call getChat");
          },
          sendMessage: async () => undefined,
        },
      },
      runtime: {
        log: () => undefined,
        error: () => undefined,
        exit: () => undefined,
      },
      opts: { token: "test-token", botInfo: telegramBotInfoForTest },
      mediaMaxBytes: 10_000,
      telegramCfg: {},
      logger: {
        info: () => undefined,
        warn: () => undefined,
      },
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveGroupActivation: () => undefined,
      resolveGroupRequireMention: () => false,
      resolveTelegramGroupConfig: () => ({}),
      shouldSkipUpdate: () => false,
      processMessage: async () => ({ kind: "completed" }),
    } as unknown as RegisterTelegramHandlerParams;
    const { handle } = createTelegramInboundPipeline({
      params,
      message,
      authorization: { authorizeInboundMessage } as TelegramHandlerAuthorization,
    });
    let messageId = 0;
    const send = (threadId: number | undefined, text: string) => {
      const msg = textMessage(++messageId, text, threadId);
      return handle(inboundContext(msg, messageId));
    };

    const topic100 = { id: 100, scope: "dm" } as const;
    const topic200 = { id: 200, scope: "dm" } as const;
    const nonTopicDm = { scope: "dm" } as const;
    const keys = {
      topic100: buildTelegramInboundDebounceConversationKey({
        chatId: CHAT_ID,
        threadSpec: topic100,
      }),
      topic200: buildTelegramInboundDebounceConversationKey({
        chatId: CHAT_ID,
        threadSpec: topic200,
      }),
      nonTopicDm: buildTelegramInboundDebounceConversationKey({
        chatId: CHAT_ID,
        threadSpec: nonTopicDm,
      }),
    };
    const dispositions = [
      await send(100, "alpha-1"),
      await send(200, "beta"),
      await send(100, "alpha-2"),
      await send(undefined, "plain-1"),
      await send(undefined, "plain-2"),
    ];
    await vi.advanceTimersByTimeAsync(40);

    console.log(
      `DM_TOPIC_DEBOUNCE_PROOF ${JSON.stringify({ keys, dispositions, flushed }, null, 2)}`,
    );

    expect(keys).toEqual({
      topic100: "7:dm-topic:100",
      topic200: "7:dm-topic:200",
      nonTopicDm: "7",
    });
    expect(dispositions).toEqual([
      { kind: "buffered", buffer: "debounce" },
      { kind: "buffered", buffer: "debounce" },
      { kind: "buffered", buffer: "debounce" },
      { kind: "buffered", buffer: "debounce" },
      { kind: "buffered", buffer: "debounce" },
    ]);
    expect(flushed).toHaveLength(3);
    expect(flushed).toEqual(
      expect.arrayContaining([
        { text: "alpha-1\nalpha-2", thread: { id: 100, scope: "dm" } },
        { text: "beta", thread: { id: 200, scope: "dm" } },
        { text: "plain-1\nplain-2", thread: { scope: "dm" } },
      ]),
    );
    expect(
      flushed.some((entry) => entry.text?.includes("alpha") && entry.text.includes("beta")),
    ).toBe(false);
    expect(
      flushed.some((entry) => entry.text?.includes("plain") && entry.text.includes("alpha")),
    ).toBe(false);
    expect(
      flushed.some((entry) => entry.text?.includes("plain") && entry.text.includes("beta")),
    ).toBe(false);
  });
});
