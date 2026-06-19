// Telegram plugin module implements bot message behavior.
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GetReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
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
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";
import { parseTelegramTarget } from "./targets.js";

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

  const processMessage = async (
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
    const recordCurrentUpdateProcessingResult = (result: TelegramMessageProcessingResult) => {
      if (options?.spooledReplay === true) {
        return;
      }
      recordTelegramMessageProcessingResult(result);
    };
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
      const result: TelegramMessageProcessingResult = { kind: "skipped" };
      recordCurrentUpdateProcessingResult(result);
      return result;
    }
    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
      );
    }
    if (
      context.ctxPayload.InboundEventKind !== "room_event" &&
      context.initialTypingCueSent !== true
    ) {
      void context.sendTyping().catch((err: unknown) => {
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
    const spooledReplay =
      options?.spooledReplay === true || isTelegramSpooledReplayUpdate(primaryCtx.update);
    try {
      const dispatchResult = await dispatchTelegramMessage({
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
        retryDispatchErrors: spooledReplay,
        suppressFailureFallback: spooledReplay,
      });
      if (dispatchResult?.kind === "failed-retryable") {
        const result: TelegramMessageProcessingResult = {
          kind: "failed-retryable",
          error: dispatchResult.error,
        };
        recordCurrentUpdateProcessingResult(result);
        return result;
      }
      if (ingressDebugEnabled && ingressReceivedAtMs) {
        logVerbose(
          `telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      const result: TelegramMessageProcessingResult = { kind: "completed" };
      recordCurrentUpdateProcessingResult(result);
      return result;
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      if (!spooledReplay) {
        try {
          await bot.api.sendMessage(
            context.chatId,
            "Something went wrong while processing your request. Please try again.",
            buildTelegramThreadParams(context.threadSpec),
          );
        } catch {}
      }
      const result: TelegramMessageProcessingResult = {
        kind: "failed-retryable",
        error: err,
      };
      recordCurrentUpdateProcessingResult(result);
      return result;
    }
  };

  /**
   * Pin-from-here mirror: re-home an origin run onto THIS channel by running a
   * synthetic inbound turn whose reply comes from the origin run's agent-event bus
   * (replyResolver) instead of the model. Reuses this processor's exact deps +
   * session runtime, so the mirror renders + persists through the normal pipeline
   * and honors this account's streaming config. Admission is skipped (the /pin was
   * the authorization). Loop-safe: replyResolver bypasses the agent-run path, so a
   * mirror turn never re-enters the mirror fan-out.
   */
  const dispatchMirror = async (mirror: {
    target: { to: string; threadId?: string | number };
    replyResolver: GetReplyFromConfig;
  }): Promise<void> => {
    // Parse the target with the canonical Telegram parser so a topic/thread encoded
    // in the target string (e.g. "telegram:-100...:topic:42") is honored, not only an
    // explicit threadId. Falls back to the explicit threadId when the string has none.
    const parsedTarget = parseTelegramTarget(mirror.target.to);
    const chatId: string | number = /^-?\d+$/.test(parsedTarget.chatId)
      ? Number(parsedTarget.chatId)
      : parsedTarget.chatId;
    const threadId =
      parsedTarget.messageThreadId ??
      (mirror.target.threadId != null && Number.isFinite(Number(mirror.target.threadId))
        ? Number(mirror.target.threadId)
        : undefined);
    const numericChatId = typeof chatId === "number" ? chatId : Number(chatId);
    const chatType: "private" | "supergroup" =
      Number.isFinite(numericChatId) && numericChatId < 0 ? "supergroup" : "private";
    const syntheticMessage = {
      message_id: 0,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: chatId,
        type: chatType,
        ...(chatType === "supergroup" ? { is_forum: threadId != null } : {}),
      },
      // For a DM the chat id IS the target user's id; use it as the synthetic
      // sender so the DM access gate evaluates the REAL pinned participant
      // (an authorized/paired DM passes; a revoked one is denied → suppressed).
      // A synthetic sender of 0 would falsely reject every paired/allowlisted DM.
      // Groups skip the per-message sender gate, so 0 is fine there.
      from: {
        id: chatType === "private" && Number.isFinite(numericChatId) ? numericChatId : 0,
        is_bot: false,
        first_name: "mirror",
      },
      // Minimal non-empty body: the body is never used (replyResolver supplies the
      // reply from the bus) but the inbound pipeline drops empty messages.
      text: "·",
      ...(threadId != null ? { message_thread_id: threadId, is_topic_message: true } : {}),
    } as unknown as TelegramContext["message"];
    const primaryCtx: TelegramContext = {
      message: syntheticMessage,
      ...(bot.botInfo ? { me: bot.botInfo } : {}),
      getFile: (async () => undefined) as unknown as TelegramContext["getFile"],
    };
    let revoked = false;
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia: [],
      storeAllowFrom: [],
      options: {
        mirror: true,
        forceWasMentioned: true,
        onMirrorAdmissionBlocked: () => {
          revoked = true;
        },
      },
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
      loadFreshConfig,
      runtime: contextRuntime,
      sessionRuntime,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
      sendChatActionHandler,
    });
    if (!context) {
      if (revoked) {
        // The destination's current policy now denies this pin (group/topic
        // disabled, or requireTopic). Drop silently and return normally so the
        // launcher KEEPS the handled-mark — the post-hoc final echo (a raw send
        // that does not re-check enablement) must not deliver the revoked content
        // either. This is the persisted-pin revocation path.
        logVerbose(
          `telegram mirror: destination policy denies ${mirror.target.to}; dropped (pin revoked)`,
        );
        return;
      }
      // Unexpected null (not a policy denial): signal failure so the launcher
      // un-marks this target and the post-hoc final echo delivers (no silent drop).
      throw new Error(`telegram mirror: context dropped for ${mirror.target.to}`);
    }
    // A mirror inbound is a synthetic re-home of an already-handled turn, NOT real
    // user input. Suppress its message:received hooks so the echo hook does not treat
    // the synthetic "." message as a user message and re-echo a phantom placeholder
    // (or fire plugin received-hook side effects) into the other pinned targets.
    context.ctxPayload.SuppressMessageReceivedHooks = true;
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
      replyResolver: mirror.replyResolver,
    });
  };

  return Object.assign(processMessage, { dispatchMirror });
};
