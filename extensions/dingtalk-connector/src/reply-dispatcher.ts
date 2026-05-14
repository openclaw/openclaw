interface ClawdbotConfig {
  [key: string]: any;
}

interface RuntimeEnv {
  log?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
  info?: (...args: any[]) => void;
  [key: string]: any;
}

const channelRuntimeModule = (await import("openclaw/plugin-sdk/channel-runtime")) as any;

const { createReplyPrefixOptions, createTypingCallbacks, logTypingFailure } = channelRuntimeModule;

import { CHANNEL_ID } from "./channel.ts";
import { resolveDingtalkAccount } from "./config/accounts.ts";
import { getDingtalkRuntime } from "./runtime.ts";
import {
  processLocalImages,
  processVideoMarkers,
  processAudioMarkers,
  uploadAndReplaceFileMarkers,
} from "./services/media/index.ts";
import { sendMessage, sendTextMessage, sendMarkdownMessage } from "./services/messaging.ts";
import type { DingtalkConfig } from "./types/index.ts";
import { createLoggerFromConfig } from "./utils/logger.ts";
import { getOapiAccessToken } from "./utils/token.ts";

export type AICardTarget = {
  type: "user" | "group";
  userId?: string;
  openConversationId?: string;
};

export type CreateDingtalkReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  conversationId: string;
  senderId: string;
  isDirect: boolean;
  accountId?: string;
  messageCreateTimeMs?: number;
  sessionWebhook: string;
  asyncMode?: boolean;
};

export function createDingtalkReplyDispatcher(params: CreateDingtalkReplyDispatcherParams) {
  const core = getDingtalkRuntime();
  const {
    cfg,
    agentId,
    conversationId,
    senderId,
    isDirect,
    accountId,
    sessionWebhook,
    asyncMode = false,
  } = params;

  const account = resolveDingtalkAccount({ cfg, accountId });
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId,
    channel: CHANNEL_ID,
    accountId,
  });

  const log = createLoggerFromConfig(account.config, `DingTalk:${accountId}`);

  const deliveredFinalTexts = new Set<string>();
  let asyncModeFullResponse = "";

  const deliveredErrorTypes = new Set<string>();
  let lastErrorTime = 0;
  const ERROR_COOLDOWN = 60000;

  const sendFallbackErrorMessage = async (
    errorType: "mediaProcess" | "sendMessage" | "unknown",
    originalError?: string,
    forceSend: boolean = false,
  ) => {
    const now = Date.now();
    const errorKey = `${errorType}:${conversationId}:${senderId}`;

    if (!forceSend && deliveredErrorTypes.has(errorKey)) return;
    if (!forceSend && now - lastErrorTime < ERROR_COOLDOWN) return;

    const errorMessages = {
      mediaProcess: "⚠️ 媒体文件处理失败，已发送文字回复",
      sendMessage: "⚠️ 消息发送失败，请稍后重试",
      unknown: "⚠️ 抱歉，处理您的请求时出错，请稍后重试",
    };

    const errorMessage = errorMessages[errorType];
    log.warn(`[DingTalk][Fallback] ${errorMessage}, error: ${originalError}`);

    try {
      await sendMessage(account.config as DingtalkConfig, sessionWebhook, errorMessage, {
        useMarkdown: false,
        log: params.runtime.log,
      });
      deliveredErrorTypes.add(errorKey);
      lastErrorTime = now;
    } catch (fallbackErr: any) {
      log.error(`[DingTalk][Fallback] 错误消息发送失败：${fallbackErr.message}`);
    }
  };

  const typingCallbacks = createTypingCallbacks({
    start: async () => {},
    stop: async () => {},
    onStartError: (err: any) =>
      logTypingFailure({
        log: (message: any) => params.runtime.log?.(message),
        channel: CHANNEL_ID,
        action: "start",
        error: err,
      }),
    onStopError: (err: any) =>
      logTypingFailure({
        log: (message: any) => params.runtime.log?.(message),
        channel: CHANNEL_ID,
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, CHANNEL_ID, accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, CHANNEL_ID);

  const groupReplyMode = (account.config as any)?.groupReplyMode || "markdown";

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        log.info(`[DingTalk][onReplyStart] 开始回复`);
        deliveredFinalTexts.clear();
        typingCallbacks.onActive?.();
      },
      deliver: async (payload: any, info: any) => {
        let text = payload.text ?? "";

        log.info(`[DingTalk][deliver] kind=${info?.kind}, textLength=${text.length}`);

        if (info?.kind === "final" && text.trim()) {
          const target: AICardTarget = isDirect
            ? { type: "user", userId: senderId }
            : { type: "group", openConversationId: conversationId };

          try {
            const oapiToken = await getOapiAccessToken(account.config as DingtalkConfig);
            if (oapiToken) {
              const { processRawMediaPaths } = await import("./services/media");
              text = await processRawMediaPaths(
                text,
                account.config as DingtalkConfig,
                oapiToken,
                log,
                target,
              );
            }
          } catch (err: any) {
            log.error(`[DingTalk][deliver] 处理裸露文件路径失败：${err.message}`);
          }
        }

        const hasText = Boolean(text.trim());
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);

        if (info?.kind === "final" && !hasText) {
          text = "✅ 任务执行完成（无文本输出）";
        }

        const shouldDeliverText = Boolean(text.trim()) && !skipTextForDuplicateFinal;
        if (!shouldDeliverText) return;

        if (asyncMode) {
          asyncModeFullResponse = text;
          return;
        }

        // block messages: discard (no streaming card to update)
        if (info?.kind === "block") return;

        if (info?.kind === "final") {
          try {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              if (!isDirect && groupReplyMode === "markdown") {
                await sendMarkdownMessage(
                  account.config as DingtalkConfig,
                  sessionWebhook,
                  chunk
                    .split("\n")[0]
                    ?.replace(/^[#*\s\->]+/, "")
                    .slice(0, 20) || "Message",
                  chunk,
                  { cfg, detectBareAliases: true },
                );
              } else if (!isDirect && groupReplyMode === "text") {
                await sendTextMessage(account.config as DingtalkConfig, sessionWebhook, chunk, {
                  cfg,
                  detectBareAliases: true,
                });
              } else {
                await sendMessage(account.config as DingtalkConfig, sessionWebhook, chunk, {
                  useMarkdown: true,
                  log: params.runtime.log,
                  cfg,
                  detectBareAliases: true,
                });
              }
            }
            deliveredFinalTexts.add(text);
          } catch (error: any) {
            log.error(`[DingTalk][deliver] 发送失败：${error.message}`);
            params.runtime.error?.(
              `dingtalk[${account.accountId}]: delivery failed: ${String(error)}`,
            );
            await sendFallbackErrorMessage("sendMessage", error.message);
          }
        }
      },
      onError: async (error: any, info: any) => {
        log.error(`[DingTalk][onError] ${info.kind} reply failed: ${String(error)}`);
        params.runtime.error?.(
          `dingtalk[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected,
    },
    markDispatchIdle,
    getAsyncModeResponse: () => asyncModeFullResponse,
  };
}
