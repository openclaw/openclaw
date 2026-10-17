// Drives the real Telegram inbound debounce path, not only key construction.
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeAllowFrom } from "./bot-access.js";
import { buildTelegramInboundDebounceConversationKey } from "./bot-handlers.debounce-key.js";
import { createTelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramChannelIngressResolver } from "./bot-message-context.types.js";
import type { TelegramMessageProcessingResult } from "./bot-processing-outcome.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";

const CHAT_ID = 7;
const SENDER_ID = "42";

function asMessagePipeline(value: object): TelegramMessagePipeline {
  return value as TelegramMessagePipeline;
}

function asBot(value: object): Bot {
  return value as Bot;
}

function asContext(value: object): TelegramContext {
  return value as TelegramContext;
}

function asHandlerParams(
  params: Pick<
    RegisterTelegramHandlerParams,
    "cfg" | "accountId" | "bot" | "runtime" | "opts" | "mediaMaxBytes" | "logger"
  >,
): RegisterTelegramHandlerParams {
  return params as RegisterTelegramHandlerParams;
}

function textMessage(messageId: number, text: string): Message {
  return {
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    chat: { id: CHAT_ID, type: "private", first_name: "Ada" },
    from: { id: 42, is_bot: false, first_name: "Ada" },
    text,
  } as Message;
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
      recordMessageResolvedMedia: () => undefined,
      mergeDispatchDedupeClaims: () => [],
      releaseDispatchDedupeClaims: () => undefined,
      settleSpooledReplayParticipants: () => undefined,
      resolveTelegramSessionState: () => undefined,
      processMessageWithReplyChain,
    };
    const pipeline = asMessagePipeline(message);
    const { processInboundMessage } = createTelegramInboundProcessing({
      params: asHandlerParams({
        cfg,
        accountId: "default",
        bot: asBot({ api: { sendMessage: async () => undefined } }),
        runtime: {
          log: () => undefined,
          error: () => undefined,
          exit: () => undefined,
        },
        opts: { token: "test-token" },
        mediaMaxBytes: 10_000,
        logger: {
          info: (_fields: Record<string, unknown>, _message: string) => undefined,
          warn: (_fields: Record<string, unknown>, _message: string) => undefined,
        },
      }),
      message: pipeline,
    });
    let messageId = 0;
    const send = (threadSpec: TelegramThreadSpec, text: string) => {
      const msg = textMessage(++messageId, text);
      return processInboundMessage({
        authorizationCfg: cfg,
        ctx: asContext({
          message: msg,
          me: { id: 1, is_bot: true, first_name: "proof", username: "proof_bot" },
          getFile: async () => {
            throw new Error("text messages do not download files");
          },
        }),
        msg,
        chatId: CHAT_ID,
        isGroup: false,
        threadSpec,
        dmPolicy: "open",
        storeAllowFrom: [],
        senderId: SENDER_ID,
        effectiveGroupAllow: normalizeAllowFrom(),
        effectiveDmAllow: normalizeAllowFrom([SENDER_ID]),
        channelIngressResolver: (async () => {
          throw new Error("debounce buffering does not resolve ingress");
        }) as TelegramChannelIngressResolver,
        sendOversizeWarning: false,
        oversizeLogMessage: "media too large",
        dispatchDedupeClaims: [],
      });
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
      await send(topic100, "alpha-1"),
      await send(topic200, "beta"),
      await send(topic100, "alpha-2"),
      await send(nonTopicDm, "plain-1"),
      await send(nonTopicDm, "plain-2"),
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
