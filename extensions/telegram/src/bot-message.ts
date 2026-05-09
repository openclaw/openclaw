import type { ReplyToMode } from "openclaw/plugin-sdk/config-types";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-types";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

const telegramInboundLog = createSubsystemLogger("gateway/channels/telegram").child("inbound");
const TELEGRAM_INTAKE_DEDUP_WINDOW_MS = 60_000;

type LastTelegramInboundMessage = {
  body: string;
  seenAtMs: number;
};

export function formatTelegramInboundLogLine(params: {
  from: string;
  to: string;
  chatType: string;
  body: string;
  mediaType?: string;
}): string {
  const kindLabel = params.mediaType ? `, ${params.mediaType}` : "";
  return `Inbound message ${params.from} -> ${params.to} (${params.chatType}${kindLabel}, ${params.body.length} chars)`;
}

type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramDeps: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token">;
};

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    telegramDeps,
    opts,
  } = deps;
  const lastInboundByChatTopic = new Map<string, LastTelegramInboundMessage>();

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
    replyChain?: TelegramReplyChainEntry[],
    promptContext?: TelegramPromptContextEntry[],
  ) => {
    const ingressReceivedAtMs =
      typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs)
        ? options.receivedAtMs
        : undefined;
    const ingressDebugEnabled =
      shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
    const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : undefined;
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      replyChain,
      promptContext,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
      loadFreshConfig,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
        logVerbose(
          `telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      return;
    }
    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
      );
    }
    const dedupKey = buildTelegramDedupKey(primaryCtx, context.chatId);
    const messageTimestampMs = getTelegramMessageTimestampMs(primaryCtx, ingressReceivedAtMs);
    if (
      shouldDropDuplicateTelegramInbound({
        cache: lastInboundByChatTopic,
        key: dedupKey,
        body: context.ctxPayload.RawBody,
        seenAtMs: messageTimestampMs,
      })
    ) {
      telegramInboundLog.info(
        `Dropped duplicate inbound message chatId=${context.chatId} topic=${formatTelegramDedupTopic(primaryCtx)} windowMs=${TELEGRAM_INTAKE_DEDUP_WINDOW_MS} bodyChars=${context.ctxPayload.RawBody.length}`,
      );
      return;
    }
    void context.sendTyping().catch((err) => {
      logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
    });
    telegramInboundLog.info(
      formatTelegramInboundLogLine({
        from: context.ctxPayload.From,
        to: context.primaryCtx.me?.username
          ? `@${context.primaryCtx.me.username}`
          : context.ctxPayload.To,
        chatType: context.ctxPayload.ChatType,
        body: context.ctxPayload.RawBody,
        mediaType: allMedia[0]?.contentType,
      }),
    );
    try {
      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        telegramDeps,
        opts,
      });
      if (ingressDebugEnabled && ingressReceivedAtMs) {
        logVerbose(
          `telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      try {
        await bot.api.sendMessage(
          context.chatId,
          "Something went wrong while processing your request. Please try again.",
          buildTelegramThreadParams(context.threadSpec),
        );
      } catch {}
    }
  };
};

function getTelegramMessageTimestampMs(
  ctx: TelegramContext,
  fallbackReceivedAtMs: number | undefined,
): number {
  const timestampSeconds = (ctx.message as { date?: unknown }).date;
  if (typeof timestampSeconds === "number" && Number.isFinite(timestampSeconds)) {
    return timestampSeconds * 1000;
  }
  return fallbackReceivedAtMs ?? Date.now();
}

function buildTelegramDedupKey(ctx: TelegramContext, chatId: number | string): string {
  return `${chatId}\u0000${formatTelegramDedupTopic(ctx)}`;
}

function formatTelegramDedupTopic(ctx: TelegramContext): string {
  const messageThreadId = (ctx.message as { message_thread_id?: unknown }).message_thread_id;
  if (typeof messageThreadId === "number" || typeof messageThreadId === "string") {
    return String(messageThreadId);
  }
  return "general";
}

function shouldDropDuplicateTelegramInbound(params: {
  cache: Map<string, LastTelegramInboundMessage>;
  key: string;
  body: string;
  seenAtMs: number;
}): boolean {
  if (params.body.length === 0) {
    params.cache.delete(params.key);
    return false;
  }

  const prior = params.cache.get(params.key);
  if (prior) {
    const ageMs = params.seenAtMs - prior.seenAtMs;
    if (
      ageMs >= 0 &&
      ageMs <= TELEGRAM_INTAKE_DEDUP_WINDOW_MS &&
      prior.body === params.body
    ) {
      return true;
    }
  }

  params.cache.set(params.key, {
    body: params.body,
    seenAtMs: params.seenAtMs,
  });
  return false;
}
