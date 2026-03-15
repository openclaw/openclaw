import type { ReplyToMode } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.telegram.js";
import { danger } from "../../../src/globals.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";

/** Dependencies injected once when creating the message processor. */
type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  opts: Pick<TelegramBotOptions, "token">;
};

const TELEGRAM_REPLY_BURST_BASE_WINDOW_MS = 10_000;
const TELEGRAM_REPLY_BURST_DENSE_WINDOW_MS = 20_000;
const TELEGRAM_REPLY_BURST_VERY_DENSE_WINDOW_MS = 25_000;
const TELEGRAM_REPLY_BURST_DENSE_MIN_SHORT_COUNT = 2;
const TELEGRAM_REPLY_BURST_VERY_DENSE_MIN_SHORT_COUNT = 4;
const TELEGRAM_SHORT_MESSAGE_MAX_CHARS = 48;
const TELEGRAM_REPLY_BURST_LEARNING_ALPHA_GAP = 0.25;
const TELEGRAM_REPLY_BURST_LEARNING_ALPHA_SHORT = 0.2;
const TELEGRAM_REPLY_BURST_LEARNING_SHORT_WEIGHT = 0.8;
const TELEGRAM_REPLY_BURST_LEARNING_BASE_MIN_MS = 6_000;
const TELEGRAM_REPLY_BURST_LEARNING_BASE_MAX_MS = 30_000;
const TELEGRAM_REPLY_BURST_LEARNING_DENSE_MULTIPLIER = 2;
const TELEGRAM_REPLY_BURST_LEARNING_VERY_DENSE_MULTIPLIER = 2.5;

type ReplyBurstAdaptiveConfig = {
  enabled: boolean;
  baseWindowMs: number;
  denseWindowMs: number;
  veryDenseWindowMs: number;
  denseShortMinCount: number;
  veryDenseShortMinCount: number;
  shortMessageMaxChars: number;
  scope: {
    private: "sender" | "chat";
    group: "sender" | "chat";
    supergroup: "sender" | "chat";
  };
  learning: {
    enabled: boolean;
    alphaGap: number;
    alphaShort: number;
    shortMessageWeight: number;
    baseMinMs: number;
    baseMaxMs: number;
    denseMultiplier: number;
    veryDenseMultiplier: number;
  };
};

type ReplyBurstState = {
  lastInboundAt: number;
  streak: number;
  recentShortMessageAt: number[];
  emaGapMs: number;
  emaShortRatio: number;
  ttlMs: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveReplyBurstAdaptiveConfig(
  telegramCfg: TelegramAccountConfig,
): ReplyBurstAdaptiveConfig {
  const cfg = telegramCfg.replyAdaptive;
  const learning = cfg?.learning;
  const baseWindowMs = cfg?.baseWindowMs ?? TELEGRAM_REPLY_BURST_BASE_WINDOW_MS;
  const denseWindowMs = cfg?.denseWindowMs ?? TELEGRAM_REPLY_BURST_DENSE_WINDOW_MS;
  const veryDenseWindowMs = cfg?.veryDenseWindowMs ?? TELEGRAM_REPLY_BURST_VERY_DENSE_WINDOW_MS;
  const baseMinMs = learning?.baseMinMs ?? TELEGRAM_REPLY_BURST_LEARNING_BASE_MIN_MS;
  const baseMaxMs = learning?.baseMaxMs ?? TELEGRAM_REPLY_BURST_LEARNING_BASE_MAX_MS;
  return {
    enabled: cfg?.enabled ?? true,
    baseWindowMs,
    denseWindowMs,
    veryDenseWindowMs,
    denseShortMinCount: cfg?.denseShortMinCount ?? TELEGRAM_REPLY_BURST_DENSE_MIN_SHORT_COUNT,
    veryDenseShortMinCount:
      cfg?.veryDenseShortMinCount ?? TELEGRAM_REPLY_BURST_VERY_DENSE_MIN_SHORT_COUNT,
    shortMessageMaxChars: cfg?.shortMessageMaxChars ?? TELEGRAM_SHORT_MESSAGE_MAX_CHARS,
    scope: {
      private: cfg?.scope?.private ?? "sender",
      group: cfg?.scope?.group ?? "chat",
      supergroup: cfg?.scope?.supergroup ?? "chat",
    },
    learning: {
      enabled: learning?.enabled ?? false,
      alphaGap: clamp(learning?.alphaGap ?? TELEGRAM_REPLY_BURST_LEARNING_ALPHA_GAP, 0, 1),
      alphaShort: clamp(learning?.alphaShort ?? TELEGRAM_REPLY_BURST_LEARNING_ALPHA_SHORT, 0, 1),
      shortMessageWeight:
        learning?.shortMessageWeight ?? TELEGRAM_REPLY_BURST_LEARNING_SHORT_WEIGHT,
      baseMinMs,
      baseMaxMs: Math.max(baseMaxMs, baseMinMs),
      denseMultiplier: learning?.denseMultiplier ?? TELEGRAM_REPLY_BURST_LEARNING_DENSE_MULTIPLIER,
      veryDenseMultiplier:
        learning?.veryDenseMultiplier ?? TELEGRAM_REPLY_BURST_LEARNING_VERY_DENSE_MULTIPLIER,
    },
  };
}

function sweepExpiredReplyBurstState(params: {
  now: number;
  burstState: Map<string, ReplyBurstState>;
}) {
  for (const [key, state] of params.burstState) {
    if (params.now - state.lastInboundAt > state.ttlMs) {
      params.burstState.delete(key);
    }
  }
}

function pruneReplyBurstStateToMaxEntries(params: {
  burstState: Map<string, ReplyBurstState>;
  maxEntries: number;
}) {
  if (params.burstState.size <= params.maxEntries) {
    return;
  }
  const overflow = params.burstState.size - params.maxEntries;
  const oldest = [...params.burstState.entries()]
    .toSorted((a, b) => a[1].lastInboundAt - b[1].lastInboundAt)
    .slice(0, overflow);
  for (const [key] of oldest) {
    params.burstState.delete(key);
  }
}

function buildReplyBurstKey(
  ctx: TelegramContext,
  adaptiveConfig: ReplyBurstAdaptiveConfig,
): string {
  const msg = ctx.message;
  const chatId = String(msg.chat.id);
  const chatType = msg.chat.type;
  const scopeType =
    chatType === "group"
      ? adaptiveConfig.scope.group
      : chatType === "supergroup"
        ? adaptiveConfig.scope.supergroup
        : adaptiveConfig.scope.private;
  const senderScope =
    scopeType === "chat" ? "chat" : msg.from?.id != null ? String(msg.from.id) : "unknown";
  const threadId =
    typeof (msg as { message_thread_id?: number }).message_thread_id === "number"
      ? String((msg as { message_thread_id?: number }).message_thread_id)
      : "none";
  return `${chatId}:${senderScope}:${threadId}`;
}

function resolveMessageTextLength(ctx: TelegramContext): number {
  const msg = ctx.message as { text?: string; caption?: string };
  const text = (msg.text ?? msg.caption ?? "").trim();
  return text.length;
}

function resolveAdaptiveReplyToMode(params: {
  configuredMode: ReplyToMode;
  burstState: Map<string, ReplyBurstState>;
  adaptiveConfig: ReplyBurstAdaptiveConfig;
  ctx: TelegramContext;
  now?: number;
  maxBurstKeys: number;
  sweepEveryMs: number;
  lastSweepAtRef: { value: number };
}): ReplyToMode {
  if (params.configuredMode === "off") {
    return "off";
  }
  if (!params.adaptiveConfig.enabled) {
    return params.configuredMode;
  }
  const now = params.now ?? Date.now();
  const key = buildReplyBurstKey(params.ctx, params.adaptiveConfig);
  const previous = params.burstState.get(key);

  const messageTextLength = resolveMessageTextLength(params.ctx);
  const shortMessage =
    messageTextLength > 0 && messageTextLength <= params.adaptiveConfig.shortMessageMaxChars;

  let baseWindowMs = params.adaptiveConfig.baseWindowMs;
  let denseWindowMs = params.adaptiveConfig.denseWindowMs;
  let veryDenseWindowMs = params.adaptiveConfig.veryDenseWindowMs;
  const recentShortMessageAt = [...(previous?.recentShortMessageAt ?? [])];
  let emaGapMs = previous?.emaGapMs ?? params.adaptiveConfig.baseWindowMs;
  let emaShortRatio = previous?.emaShortRatio ?? (shortMessage ? 1 : 0);

  if (params.adaptiveConfig.learning.enabled && previous) {
    const gapMs = now - previous.lastInboundAt;
    emaGapMs =
      params.adaptiveConfig.learning.alphaGap * gapMs +
      (1 - params.adaptiveConfig.learning.alphaGap) * previous.emaGapMs;
    emaShortRatio =
      params.adaptiveConfig.learning.alphaShort * (shortMessage ? 1 : 0) +
      (1 - params.adaptiveConfig.learning.alphaShort) * previous.emaShortRatio;
    baseWindowMs = clamp(
      emaGapMs * (1 + params.adaptiveConfig.learning.shortMessageWeight * emaShortRatio),
      params.adaptiveConfig.learning.baseMinMs,
      params.adaptiveConfig.learning.baseMaxMs,
    );
    denseWindowMs = baseWindowMs * params.adaptiveConfig.learning.denseMultiplier;
    veryDenseWindowMs = baseWindowMs * params.adaptiveConfig.learning.veryDenseMultiplier;
  }

  const filteredRecentShortMessageAt = recentShortMessageAt.filter(
    (ts) => now - ts <= veryDenseWindowMs,
  );
  if (shortMessage) {
    filteredRecentShortMessageAt.push(now);
  }

  const shortCount = filteredRecentShortMessageAt.length;
  const burstWindowMs =
    shortCount >= params.adaptiveConfig.veryDenseShortMinCount
      ? veryDenseWindowMs
      : shortCount >= params.adaptiveConfig.denseShortMinCount
        ? denseWindowMs
        : baseWindowMs;

  const withinBurst = previous != null && now - previous.lastInboundAt <= burstWindowMs;
  const streak = withinBurst ? previous.streak + 1 : 1;
  params.burstState.set(key, {
    lastInboundAt: now,
    streak,
    recentShortMessageAt: filteredRecentShortMessageAt,
    emaGapMs,
    emaShortRatio,
    ttlMs: Math.max(veryDenseWindowMs, params.adaptiveConfig.veryDenseWindowMs),
  });
  const shouldSweep = now - (params.lastSweepAtRef.value ?? 0) >= params.sweepEveryMs;
  if (shouldSweep) {
    sweepExpiredReplyBurstState({
      now,
      burstState: params.burstState,
    });
    params.lastSweepAtRef.value = now;
  }
  pruneReplyBurstStateToMaxEntries({
    burstState: params.burstState,
    maxEntries: params.maxBurstKeys,
  });
  return streak >= 2 ? params.configuredMode : "off";
}

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
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
  } = deps;

  const replyBurstState = new Map<string, ReplyBurstState>();
  const replyBurstAdaptiveConfig = resolveReplyBurstAdaptiveConfig(telegramCfg);
  const replyBurstLastSweepAtRef = { value: 0 };
  const replyBurstSweepEveryMs = 2_000;
  const replyBurstMaxKeys = 5_000;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
    replyMedia?: TelegramMediaRef[],
  ) => {
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
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
    });
    if (!context) {
      return;
    }
    try {
      const effectiveReplyToMode = resolveAdaptiveReplyToMode({
        configuredMode: replyToMode,
        burstState: replyBurstState,
        adaptiveConfig: replyBurstAdaptiveConfig,
        ctx: primaryCtx,
        maxBurstKeys: replyBurstMaxKeys,
        sweepEveryMs: replyBurstSweepEveryMs,
        lastSweepAtRef: replyBurstLastSweepAtRef,
      });

      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode: effectiveReplyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        opts,
      });
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      try {
        await bot.api.sendMessage(
          context.chatId,
          "Something went wrong while processing your request. Please try again.",
          context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : undefined,
        );
      } catch {
        // Best-effort fallback; delivery may fail if the bot was blocked or the chat is invalid.
      }
    }
  };
};
