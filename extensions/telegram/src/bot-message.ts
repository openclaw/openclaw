import { randomUUID } from "node:crypto";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
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
import {
  buildTelegramDeferredRunFailureText,
  buildTelegramLongTurnDeferralText,
  createTelegramLongTurnDeliveryState,
  formatTelegramDeferredRunTarget,
  TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS,
} from "./long-turn-delivery.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

const telegramInboundLog = createSubsystemLogger("gateway/channels/telegram").child("inbound");

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

export type TelegramMessageProcessorLifecycle = {
  onDispatchStart?: () => Promise<void> | void;
};

type TelegramDispatchOutcome = { status: "completed" } | { status: "failed"; error: unknown };

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
  const sessionRuntime = {
    ...(telegramDeps.buildChannelInboundEventContext
      ? { buildChannelInboundEventContext: telegramDeps.buildChannelInboundEventContext }
      : {}),
    ...(telegramDeps.readSessionUpdatedAt
      ? { readSessionUpdatedAt: telegramDeps.readSessionUpdatedAt }
      : {}),
    ...(telegramDeps.recordInboundSession
      ? { recordInboundSession: telegramDeps.recordInboundSession }
      : {}),
    ...(telegramDeps.resolveInboundLastRouteSessionKey
      ? { resolveInboundLastRouteSessionKey: telegramDeps.resolveInboundLastRouteSessionKey }
      : {}),
    ...(telegramDeps.resolvePinnedMainDmOwnerFromAllowlist
      ? {
          resolvePinnedMainDmOwnerFromAllowlist: telegramDeps.resolvePinnedMainDmOwnerFromAllowlist,
        }
      : {}),
    resolveStorePath: telegramDeps.resolveStorePath,
  };
  const contextRuntime = telegramDeps.recordChannelActivity
    ? { recordChannelActivity: telegramDeps.recordChannelActivity }
    : undefined;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
    replyChain?: TelegramReplyChainEntry[],
    promptContext?: TelegramPromptContextEntry[],
    lifecycle?: TelegramMessageProcessorLifecycle,
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
      runtime: contextRuntime,
      sessionRuntime,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
        logVerbose(
          `telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      return false;
    }
    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
      );
    }
    if (context.ctxPayload.InboundEventKind !== "room_event") {
      void context.sendTyping().catch((err) => {
        logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
      });
    }
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
    await lifecycle?.onDispatchStart?.();
    try {
      const longTurnDeliveryState = createTelegramLongTurnDeliveryState({
        runId: randomUUID(),
        agentId: context.route.agentId,
        accountId: context.route.accountId,
        sessionKey: context.ctxPayload.SessionKey,
        chatId: String(context.chatId),
        threadId: context.threadSpec?.id,
      });
      const dispatchPromise = Promise.resolve().then(() =>
        dispatchTelegramMessage({
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
          runId: longTurnDeliveryState.runId,
          longTurnDeliveryState,
        }),
      );
      const dispatchOutcome: Promise<TelegramDispatchOutcome> = dispatchPromise.then(
        () => ({ status: "completed" }),
        (error: unknown) => ({ status: "failed", error }),
      );
      const canDefer = context.ctxPayload.InboundEventKind !== "room_event" && !context.isGroup;
      let softDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const softDeadline = canDefer
        ? new Promise<"soft-deadline">((resolve) => {
            softDeadlineTimer = setTimeout(
              () => resolve("soft-deadline"),
              TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS,
            );
          })
        : undefined;
      const firstOutcome = softDeadline
        ? await Promise.race([dispatchOutcome, softDeadline])
        : await dispatchOutcome;
      if (softDeadlineTimer) {
        clearTimeout(softDeadlineTimer);
      }
      if (firstOutcome === "soft-deadline") {
        if (
          longTurnDeliveryState.hasFinalDeliveryStarted() ||
          !longTurnDeliveryState.canSendDeferralNotice()
        ) {
          const finalOutcome = await dispatchOutcome;
          if (finalOutcome.status === "failed") {
            throw finalOutcome.error;
          }
          return true;
        }
        longTurnDeliveryState.markDeferralPending();
        const target = formatTelegramDeferredRunTarget({
          chatId: context.chatId,
          threadId: context.threadSpec?.id,
        });
        void dispatchOutcome.then(async (outcome) => {
          if (outcome.status === "completed") {
            return;
          }
          await longTurnDeliveryState.waitForDeferralNotice();
          runtime.error?.(danger(`telegram deferred dispatch failed: ${String(outcome.error)}`));
          try {
            await bot.api.sendMessage(
              context.chatId,
              buildTelegramDeferredRunFailureText({
                runId: longTurnDeliveryState.runId,
                agentId: longTurnDeliveryState.agentId,
                sessionKey: longTurnDeliveryState.sessionKey,
                target,
              }),
              buildTelegramThreadParams(context.threadSpec),
            );
          } catch {}
        });
        try {
          await bot.api.sendMessage(
            context.chatId,
            buildTelegramLongTurnDeferralText({ runId: longTurnDeliveryState.runId }),
            buildTelegramThreadParams(context.threadSpec),
          );
        } catch (err) {
          runtime.error?.(danger(`telegram long-turn deferral failed: ${String(err)}`));
        } finally {
          longTurnDeliveryState.markDeferred();
        }
        return true;
      }
      if (firstOutcome.status === "failed") {
        throw firstOutcome.error;
      }
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
    return true;
  };
};
