import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type OutboundIdentity,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/feishu";
import type { ModelSelectedContext } from "../../../src/auto-reply/types.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  sendMarkdownCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";
import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

/** Maximum age (ms) for a message to receive a typing indicator reaction.
 * Messages older than this are likely replays after context compaction (#30418). */
const TYPING_INDICATOR_MAX_AGE_MS = 2 * 60_000;
const MS_EPOCH_MIN = 1_000_000_000_000;

function normalizeEpochMs(timestamp: number | undefined): number | undefined {
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  // Defensive normalization: some payloads use seconds, others milliseconds.
  // Values below 1e12 are treated as epoch-seconds.
  return timestamp < MS_EPOCH_MIN ? timestamp * 1000 : timestamp;
}

/** Build a card header from agent identity config. */
function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig {
  const name = identity?.name?.trim() || agentId;
  const emoji = identity?.emoji?.trim();
  return {
    title: emoji ? `${emoji} ${name}` : name,
    template: identity?.theme ?? "blue",
  };
}

/** Build a card note footer from agent identity and model context. */
function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  /** When true, preserve typing indicator on reply target but send messages without reply metadata */
  skipReplyToInMessages?: boolean;
  replyInThread?: boolean;
  /** True when inbound message is already inside a thread/topic context */
  threadReply?: boolean;
  rootId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
  identity?: OutboundIdentity;
  /** Epoch ms when the inbound message was created. Used to suppress typing
   *  indicators on old/replayed messages after context compaction (#30418). */
  messageCreateTimeMs?: number;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const {
    cfg,
    agentId,
    chatId,
    replyToMessageId,
    skipReplyToInMessages,
    replyInThread,
    threadReply,
    rootId,
    mentionTargets,
    accountId,
    identity,
  } = params;
  const sendReplyToMessageId = skipReplyToInMessages ? undefined : replyToMessageId;
  const threadReplyMode = threadReply === true;
  const effectiveReplyInThread = threadReplyMode ? true : replyInThread;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      // Check if typing indicator is enabled (default: true)
      if (!(account.config.typingIndicator ?? true)) {
        return;
      }
      if (!replyToMessageId) {
        return;
      }
      // Skip typing indicator for old messages — likely replays after context
      // compaction that would flood users with stale notifications (#30418).
      const messageCreateTimeMs = normalizeEpochMs(params.messageCreateTimeMs);
      if (
        messageCreateTimeMs !== undefined &&
        Date.now() - messageCreateTimeMs > TYPING_INDICATOR_MAX_AGE_MS
      ) {
        return;
      }
      // Feishu reactions persist until explicitly removed, so skip keepalive
      // re-adds when a reaction already exists. Re-adding the same emoji
      // triggers a new push notification for every call (#28660).
      if (typingState?.reactionId) {
        return;
      }
      typingState = await addTypingIndicator({
        cfg,
        messageId: replyToMessageId,
        accountId,
        runtime: params.runtime,
      });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId, runtime: params.runtime });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  // Card streaming may miss thread affinity in topic contexts; use direct replies there.
  const streamingEnabled =
    !threadReplyMode && account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let answerText = "";
  let lastPartial = "";
  let currentToolName: string | undefined;
  let currentReasoning = "";
  let displayedModelName = "";
  let isCompacting = false;

  const streamModelNameAnimation = async (fullModelName: string) => {
    displayedModelName = "";
    for (let i = 1; i <= fullModelName.length; i++) {
      displayedModelName = fullModelName.slice(0, i);
      queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  const getCoolToolMessage = (toolName: string): string => {
    const messages: Record<string, string> = {
      exec: "💻 使用工具 exec 处理，请稍等...",
      google_search: "🔍 使用工具 google_search 处理，请稍等...",
      duckduckgo_search: "🔍 使用工具 duckduckgo_search 处理，请稍等...",
      bing_search: "🔍 使用工具 bing_search 处理，请稍等...",
      sessions_spawn: "🤖 正在召唤子代理，请稍等...",
      web_search: "🌍 正在搜索互联网，请稍等...",
      compaction: "🧹 正在整理深度记忆碎片，请稍等...",
      thinking: "🤔 正在深度思考中，请稍等...",
      writing: "✍️ 正在生成回复内容，请稍等...",
    };
    return messages[toolName] ?? `🛠️ 使用工具 ${toolName} 处理，请稍等...`;
  };

  const buildStreamingContent = (text: string) => {
    const trimmedText = text.trim();

    let statusLine = "";
    if (isCompacting) {
      statusLine = `**[${getCoolToolMessage("compaction")}]** `;
    } else if (currentToolName) {
      statusLine = `**[${getCoolToolMessage(currentToolName)}]** `;
    } else if (currentReasoning && !trimmedText) {
      statusLine = `**[${getCoolToolMessage("thinking")}]** `;
    }

    if (trimmedText) {
      if (statusLine) {
        return `${statusLine}\n\n${text}`;
      }
      return text;
    }

    let statusHeader = "";
    if (displayedModelName) {
      statusHeader = `🧠 Thinking... *via ${displayedModelName}*\n`;
    }
    statusHeader += statusLine ? `${statusLine}\n` : "";

    let content = statusHeader;
    if (currentReasoning) {
      const lines = currentReasoning.split("\n").map((line) => `> ${line}`);
      content += `> 💭 **Thinking**\n${lines.join("\n")}\n\n`;
    }

    if (text && !trimmedText && !statusLine) {
      content += `**[${getCoolToolMessage("writing")}]**\n\n`;
    }

    content += statusHeader || currentReasoning || text ? "" : "⏳ Thinking...";
    return content;
  };

  const deliveredFinalTexts = new Set<string>();
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;
  type StreamTextUpdateMode = "snapshot" | "delta";

  const queueStreamingUpdate = (
    nextText: string,
    options?: {
      dedupeWithLastPartial?: boolean;
      mode?: StreamTextUpdateMode;
      forceRefresh?: boolean;
      useReplace?: boolean;
    },
  ) => {
    if (!nextText && !options?.forceRefresh) {
      return;
    }
    if (options?.dedupeWithLastPartial && nextText === lastPartial) {
      return;
    }
    if (options?.dedupeWithLastPartial) {
      lastPartial = nextText;
    }
    const mode = options?.mode ?? "snapshot";

    if (nextText) {
      answerText =
        mode === "delta" ? `${answerText}${nextText}` : mergeStreamingText(answerText, nextText);
    }

    partialUpdateQueue = partialUpdateQueue.then(async () => {
      if (streamingStartPromise) {
        await streamingStartPromise;
      }
      if (streaming?.isActive()) {
        const fullContent = buildStreamingContent(answerText);
        await streaming.replaceContent(fullContent);
      }
    });
  };

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      const receiveIdType = resolveReceiveIdType(chatId);
      params.runtime.log?.(
        `feishu[${account.accountId}] starting streaming: chatId=${chatId} type=${receiveIdType} replyTo=${replyToMessageId}`,
      );
      try {
        const cardHeader = resolveCardHeader(agentId, identity);
        const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
        await streaming.start(chatId, receiveIdType, {
          replyToMessageId,
          replyInThread: effectiveReplyInThread,
          rootId,
          header: cardHeader,
          note: cardNote,
        });
      } catch (error) {
        params.runtime.error?.(
          `feishu: streaming start failed for chatId=${chatId} type=${receiveIdType}: ${String(error)}`,
        );
        streaming = null;
        streamingStartPromise = null; // allow retry on next deliver
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = answerText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      const finalNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
      currentToolName = undefined;
      isCompacting = false;
      await streaming.close(text, { note: finalNote });
    }
    streaming = null;
    streamingStartPromise = null;
    answerText = "";
    lastPartial = "";
    currentToolName = undefined;
    currentReasoning = "";
    isCompacting = false;
  };

  const sendChunkedTextReply = async (chunkParams: {
    text: string;
    useCard: boolean;
    infoKind?: string;
  }) => {
    let first = true;
    const chunkSource = chunkParams.useCard
      ? chunkParams.text
      : core.channel.text.convertMarkdownTables(chunkParams.text, tableMode);
    for (const chunk of core.channel.text.chunkTextWithMode(
      chunkSource,
      textChunkLimit,
      chunkMode,
    )) {
      const message = {
        cfg,
        to: chatId,
        text: chunk,
        replyToMessageId: sendReplyToMessageId,
        replyInThread: effectiveReplyInThread,
        mentions: first ? mentionTargets : undefined,
        accountId,
      };
      if (chunkParams.useCard) {
        await sendMarkdownCardFeishu(message);
      } else {
        await sendMessageFeishu(message);
      }
      first = false;
    }
    if (chunkParams.infoKind === "final") {
      deliveredFinalTexts.add(chunkParams.text);
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        deliveredFinalTexts.clear();
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        params.runtime.log?.(
          `feishu[${account.accountId}] deliver: kind=${info?.kind} textLen=${payload.text?.length ?? 0}`,
        );
        const text = payload.text ?? "";
        const mediaList =
          payload.mediaUrls && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : payload.mediaUrl
              ? [payload.mediaUrl]
              : [];
        const hasText = Boolean(text.trim());
        const hasMedia = mediaList.length > 0;
        const skipTextForDuplicateFinal =
          info?.kind === "final" && hasText && deliveredFinalTexts.has(text);
        const shouldDeliverText = hasText && !skipTextForDuplicateFinal;

        if (!shouldDeliverText && !hasMedia) {
          return;
        }

        if (shouldDeliverText) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
          params.runtime.log?.(
            `feishu[${account.accountId}] info: useCard=${useCard} renderMode=${renderMode} streamingEnabled=${streamingEnabled}`,
          );

          if (info?.kind === "block") {
            const blockStreamingEnabled = account.config?.blockStreaming !== false;
            if (!(streamingEnabled && useCard) && !blockStreamingEnabled) {
              params.runtime.log?.(
                `feishu[${account.accountId}] info: dropping block because neither card streaming nor block streaming is enabled`,
              );
              return;
            }
            if (streamingEnabled && useCard) {
              startStreaming();
              if (streamingStartPromise) {
                await streamingStartPromise;
              }
            }
          }

          if (info?.kind === "final" && streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "block") {
              answerText = mergeStreamingText(answerText, text);
              queueStreamingUpdate("", { forceRefresh: true });
            }
            if (info?.kind === "final") {
              answerText = mergeStreamingText(answerText, text);
              deliveredFinalTexts.add(text);
              await closeStreaming();
            }
            if (hasMedia) {
              for (const mediaUrl of mediaList) {
                await sendMediaFeishu({
                  cfg,
                  to: chatId,
                  mediaUrl,
                  replyToMessageId: sendReplyToMessageId,
                  replyInThread: effectiveReplyInThread,
                  accountId,
                });
              }
            }
            return;
          }

          if (useCard) {
            const cardHeader = resolveCardHeader(agentId, identity);
            const cardNote = resolveCardNote(agentId, identity, prefixContext.prefixContext);
            let first = true;
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              await sendStructuredCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
                header: cardHeader,
                note: cardNote,
              });
              first = false;
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            let first = true;
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              params.runtime.log?.(
                `feishu[${account.accountId}] info: calling sendMessageFeishu for chunk len=${chunk.length}`,
              );
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId: sendReplyToMessageId,
                replyInThread: effectiveReplyInThread,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
            if (info?.kind === "final") {
              deliveredFinalTexts.add(text);
            }
          }
        }

        if (hasMedia) {
          for (const mediaUrl of mediaList) {
            await sendMediaFeishu({
              cfg,
              to: chatId,
              mediaUrl,
              replyToMessageId: sendReplyToMessageId,
              replyInThread: effectiveReplyInThread,
              accountId,
            });
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
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
      onModelSelected: (ctx: ModelSelectedContext) => {
        prefixContext.onModelSelected?.(ctx);
        if (renderMode === "card" && streamingEnabled) {
          startStreaming();
          streamModelNameAnimation(ctx.model).catch(() => {});
        }
      },
      disableBlockStreaming: false,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text) {
              return;
            }
            if (renderMode === "card") {
              startStreaming();
            }
            queueStreamingUpdate(payload.text, {
              mode: "snapshot",
            });
          }
        : undefined,
      onToolStart: streamingEnabled
        ? async (payload: { name?: string; phase?: string }) => {
            currentToolName = payload.name;
            if (renderMode === "card") {
              startStreaming();
              queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
            }
          }
        : undefined,
      onToolResult: streamingEnabled
        ? async () => {
            currentToolName = undefined;
            if (renderMode === "card") {
              queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
            }
          }
        : undefined,
      onReasoningStream: streamingEnabled
        ? async (payload: ReplyPayload) => {
            if (payload.text) {
              currentReasoning = mergeStreamingText(currentReasoning, payload.text);
              if (renderMode === "card") {
                startStreaming();
                queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
              }
            }
          }
        : undefined,
      onAssistantMessageStart: streamingEnabled
        ? async () => {
            currentToolName = undefined;
            if (renderMode === "card") {
              // Vital: clear status/tool decorations by replacing with clean answer state
              queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
            }
          }
        : undefined,
      onCompactionStart: streamingEnabled
        ? async () => {
            isCompacting = true;
            if (renderMode === "card") {
              startStreaming();
              queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
            }
          }
        : undefined,
      onCompactionEnd: streamingEnabled
        ? async () => {
            isCompacting = false;
            if (renderMode === "card") {
              queueStreamingUpdate("", { forceRefresh: true, useReplace: true });
            }
          }
        : undefined,
    },
    markDispatchIdle: async () => {
      await markDispatchIdle();
    },
  };
}
