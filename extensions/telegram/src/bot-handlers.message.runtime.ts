// Telegram message/session/prompt pipeline shared by bot handler registrars.
import type { Message } from "grammy/types";
import { resolveStoredModelOverride } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import {
  getSessionEntry,
  listSessionEntries,
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { stripInlineDirectiveTagsForDelivery } from "openclaw/plugin-sdk/text-chunking";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";
import { resolveTelegramAccount, resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { firstDefined, isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";
import { resolveDefaultModelForAgent } from "./bot-handlers.agent.runtime.js";
import { hasInboundMedia, resolveInboundMediaFileId } from "./bot-handlers.media.js";
import type { TelegramMediaRef } from "./bot-message-context.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramMessageContextOptions,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  createTelegramSpooledReplayParticipant,
  getTelegramSpooledReplayDeferredParticipant,
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
  type TelegramMessageProcessingResult,
  type TelegramSpooledReplayDeferredParticipant,
  type TelegramSpooledReplaySettlementHold,
} from "./bot-processing-outcome.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import {
  buildSenderName,
  getTelegramTextParts,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumThreadId,
  resolveTelegramMediaPlaceholder,
  shouldUseTelegramDmThreadSession,
} from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import {
  resolveTelegramConversationBaseSessionKey,
  resolveTelegramConversationRoute,
} from "./conversation-route.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import {
  buildTelegramSelfSenderName,
  isTelegramHistoryEntryAfterAmbientWatermark,
  isTelegramSelfSenderName,
} from "./group-history-window.js";
import {
  buildTelegramConversationContext,
  buildTelegramReplyChain,
  createTelegramMessageCache,
  isTelegramMessageFromCurrentBot,
  isTelegramSessionBoundaryCommandText,
  resolveTelegramMessageCacheScope,
  type TelegramCachedMessageNode,
  type TelegramReplyChainEntry,
} from "./message-cache.js";
import {
  claimTelegramMessageDispatchReplay,
  commitTelegramMessageDispatchReplay,
  createTelegramMessageDispatchReplayGuard,
  releaseTelegramMessageDispatchReplay,
} from "./message-dispatch-dedupe.js";
import { resolveCompleteTelegramPromptContextProjectionIds } from "./prompt-context-projection.js";
import { resolveTelegramPromptMediaPath } from "./prompt-media-path.js";
import { buildTelegramSessionTranscriptPromptEntries } from "./session-transcript-context.js";

function hasLegacyPromptContextTimestamp(
  node: TelegramCachedMessageNode,
  botUserId?: number,
): boolean {
  if (node.promptContextProjectionMarker) {
    return false;
  }
  const timestamp = (
    node.sourceMessage as Message & { openclaw_prompt_context_timestamp_ms?: unknown }
  ).openclaw_prompt_context_timestamp_ms;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return false;
  }
  // Shipped previews created before bot identity was available used id 0. The
  // private timestamp marker is their durable outbound provenance.
  return (
    isTelegramMessageFromCurrentBot(node.sourceMessage, botUserId) ||
    (node.sourceMessage.from?.id === 0 && node.sourceMessage.from.is_bot)
  );
}

type TelegramPromptContextMessageForDedupe = {
  body?: unknown;
  timestamp_ms?: unknown;
};

function resolvePromptContextTextDedupeKey(
  message: TelegramPromptContextMessageForDedupe,
): string | undefined {
  if (typeof message.body !== "string") {
    return undefined;
  }
  const visibleBody = stripInlineDirectiveTagsForDelivery(message.body).text.trim();
  if (!visibleBody) {
    return undefined;
  }
  if (typeof message.timestamp_ms !== "number" || !Number.isFinite(message.timestamp_ms)) {
    return undefined;
  }
  return `${message.timestamp_ms}:${visibleBody}`;
}

type TelegramPromptContextMessageSelection = ReadonlyMap<string, "include" | "exclude">;

export function createTelegramHandlerMessageRuntime({
  cfg,
  accountId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  resolveTelegramGroupConfig,
  processMessage,
  logger,
  telegramDeps,
}: RegisterTelegramHandlerParams) {
  const { token } = opts;
  const mediaRuntimeOptions = resolveTelegramMediaRuntimeOptions({
    cfg,
    accountId,
    token,
    transport: telegramTransport,
  });
  const mediaAbortSignal =
    opts.mediaAbortSignal && opts.fetchAbortSignal
      ? AbortSignal.any([opts.mediaAbortSignal, opts.fetchAbortSignal])
      : (opts.mediaAbortSignal ?? opts.fetchAbortSignal);
  const mediaRuntimeWithAbort = {
    ...mediaRuntimeOptions,
    abortSignal: mediaAbortSignal,
  };
  const messageCache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(telegramDeps.resolveStorePath(cfg.session?.store)),
  });
  const resolvePromptSender = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
  ): string | undefined => {
    const botInfo = ctx.me ?? opts.botInfo;
    // Business replies keep the account user in `from`; Telegram authenticates the bot separately.
    const isAuthenticatedSelf =
      botInfo?.id != null &&
      (node.senderId === String(botInfo.id) ||
        node.sourceMessage.sender_business_bot?.id === botInfo.id);
    if (isAuthenticatedSelf) {
      return buildTelegramSelfSenderName(telegramCfg.name, botInfo);
    }
    if (node.senderId === "0" && node.sourceMessage.from?.is_bot === true) {
      return node.sender;
    }
    // Config reloads restart this handler; `(you)` stays reserved for authenticated bot ids.
    return isTelegramSelfSenderName(node.sender) ? `${node.sender} (Telegram sender)` : node.sender;
  };
  const messageDispatchReplayGuard = createTelegramMessageDispatchReplayGuard({
    onDiskError: (error) => {
      runtime.error?.(danger(`[telegram] message dispatch dedupe store failed: ${String(error)}`));
    },
  });

  const normalizePromptContextMinTimestampMs = (timestampMs?: number) =>
    typeof timestampMs === "number" && Number.isFinite(timestampMs) ? timestampMs : undefined;
  const promptContextBoundaryOptions = (
    timestampMs?: number,
    ambientWatermark?: TelegramAmbientTranscriptWatermark,
  ): Pick<
    TelegramMessageContextOptions,
    "promptContextMinTimestampMs" | "promptContextAmbientWatermark"
  > => {
    const promptContextMinTimestampMs = normalizePromptContextMinTimestampMs(timestampMs);
    return {
      ...(promptContextMinTimestampMs === undefined ? {} : { promptContextMinTimestampMs }),
      ...(ambientWatermark === undefined
        ? {}
        : { promptContextAmbientWatermark: ambientWatermark }),
    };
  };
  const latestPromptContextMinTimestampMs = (
    ...timestamps: Array<number | undefined>
  ): number | undefined => {
    let latest: number | undefined;
    for (const timestampMs of timestamps) {
      const normalized = normalizePromptContextMinTimestampMs(timestampMs);
      if (normalized === undefined) {
        continue;
      }
      latest = latest === undefined ? normalized : Math.max(latest, normalized);
    }
    return latest;
  };
  const latestPromptContextAmbientWatermark = (
    ...watermarks: Array<TelegramAmbientTranscriptWatermark | undefined>
  ): TelegramAmbientTranscriptWatermark | undefined => {
    return watermarks.findLast((watermark) => watermark !== undefined);
  };
  const mergeDispatchDedupeKeys = (...groups: Array<readonly string[] | undefined>) => [
    ...new Set(normalizeStringEntries(groups.flatMap((group) => group ?? []))),
  ];
  const releaseDispatchDedupeKeys = (keys: readonly string[], error?: unknown) => {
    releaseTelegramMessageDispatchReplay({
      guard: messageDispatchReplayGuard,
      keys,
      error,
    });
  };
  const commitDispatchDedupeKeys = async (
    keys: readonly string[],
    options: { requirePersistent?: boolean } = {},
  ) => {
    await commitTelegramMessageDispatchReplay({
      guard: messageDispatchReplayGuard,
      keys,
      ...options,
    });
  };
  const buildFailedProcessingResult = (error: unknown): TelegramMessageProcessingResult => ({
    kind: "failed-retryable",
    error,
  });
  const settleSpooledReplayParticipants = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
    result: TelegramMessageProcessingResult,
  ) => {
    for (const participant of new Set(participants)) {
      participant.settle(result);
    }
  };
  const beginSpooledReplaySettlementHolds = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ) => {
    const holds: TelegramSpooledReplaySettlementHold[] = [];
    for (const participant of new Set(participants)) {
      const hold = participant.beginSettlementHold();
      if (!hold) {
        for (const acquired of holds) {
          acquired.release("replay-pending");
        }
        const reason = participant.abortSignal.reason;
        throw reason instanceof Error
          ? reason
          : new Error(
              `telegram spooled replay participant ${participant.key} settled before durable adoption`,
            );
      }
      holds.push(hold);
    }
    return (mode: Parameters<TelegramSpooledReplaySettlementHold["release"]>[0]) => {
      for (const hold of holds) {
        hold.release(mode);
      }
    };
  };
  const createSpooledReplayParticipantForBufferedWork = (
    key: string,
  ): TelegramSpooledReplayDeferredParticipant | undefined =>
    createTelegramSpooledReplayDeferredParticipant(key) ?? undefined;
  const spooledReplayOptions = (
    participants: readonly TelegramSpooledReplayDeferredParticipant[],
  ): Pick<TelegramMessageContextOptions, "spooledReplay"> =>
    participants.length > 0 ? { spooledReplay: true } : {};
  const claimMessageDispatchDedupe = async (
    msg: Message,
  ): Promise<{ process: true; keys: string[] } | { process: false }> => {
    const claim = await claimTelegramMessageDispatchReplay({
      guard: messageDispatchReplayGuard,
      accountId,
      msg,
    });
    if (claim.kind === "duplicate") {
      logVerbose(`telegram dispatch dedupe: skipped message ${msg.chat.id}:${msg.message_id}`);
      return { process: false };
    }
    return { process: true, keys: claim.kind === "claimed" ? [claim.key] : [] };
  };
  const buildSyntheticTextMessage = (params: {
    base: Message;
    text: string;
    date?: number;
    from?: Message["from"];
  }): Message => ({
    ...params.base,
    ...(params.from ? { from: params.from } : {}),
    text: params.text,
    caption: undefined,
    caption_entities: undefined,
    entities: undefined,
    ...(params.date != null ? { date: params.date } : {}),
  });
  // grammy's Context.getFile reads update state via `this`; keep the receiver bound.
  const buildSyntheticContext = (
    ctx: Pick<TelegramContext, "me" | "getFile">,
    message: Message,
  ): TelegramContext => ({ message, me: ctx.me, getFile: ctx.getFile.bind(ctx) });

  const formatTelegramAmbientTranscriptLine = (msg: Message): string => {
    const text = getTelegramTextParts(msg).text.trim();
    const body =
      text || resolveTelegramMediaPlaceholder(msg) || "[User sent media without caption]";
    const messageId = msg.message_id ? `#${msg.message_id}` : undefined;
    const sender = buildSenderName(msg);
    const prefix = [messageId, sender].filter(Boolean).join(" ");
    return prefix ? `${prefix}: ${body}` : body;
  };

  const formatTelegramAmbientTranscriptBody = (
    messages: readonly Message[],
  ): string | undefined => {
    const lines = messages.map(formatTelegramAmbientTranscriptLine);
    return lines.length > 0 ? lines.join("\n") : undefined;
  };

  const resolveTelegramSessionState = (params: {
    chatId: number | string;
    isGroup: boolean;
    isForum: boolean;
    messageThreadId?: number;
    resolvedThreadId?: number;
    botHasTopicsEnabled?: boolean;
    senderId?: string | number;
    runtimeCfg: OpenClawConfig;
  }): {
    agentId: string;
    sessionEntry: ReturnType<typeof getSessionEntry>;
    sessionKey: string;
    storePath: string;
    model?: string;
  } => {
    const runtimeCfg = params.runtimeCfg;
    const resolvedThreadId =
      params.resolvedThreadId ??
      resolveTelegramForumThreadId({
        isForum: params.isForum,
        messageThreadId: params.messageThreadId,
      });
    const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
    const topicThreadId = resolvedThreadId ?? dmThreadId;
    const { topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId, runtimeCfg);
    const { route } = resolveTelegramConversationRoute({
      cfg: runtimeCfg,
      accountId,
      chatId: params.chatId,
      isGroup: params.isGroup,
      resolvedThreadId,
      replyThreadId: topicThreadId,
      senderId: params.senderId,
      topicAgentId: topicConfig?.agentId,
    });
    const baseSessionKey = resolveTelegramConversationBaseSessionKey({
      cfg: runtimeCfg,
      route,
      chatId: params.chatId,
      isGroup: params.isGroup,
      senderId: params.senderId,
    });
    const threadKeys =
      shouldUseTelegramDmThreadSession({
        dmThreadId,
        botHasTopicsEnabled: params.botHasTopicsEnabled,
      }) && dmThreadId != null
        ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${params.chatId}:${dmThreadId}` })
        : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = telegramDeps.resolveStorePath(runtimeCfg.session?.store, {
      agentId: route.agentId,
    });
    const entry = (telegramDeps.getSessionEntry ?? getSessionEntry)({ storePath, sessionKey });
    const store = Object.fromEntries(
      (telegramDeps.listSessionEntries ?? listSessionEntries)({ storePath }).map(
        ({ sessionKey: key, entry: value }) => [key, value],
      ),
    );
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey,
      defaultProvider: resolveDefaultModelForAgent({
        cfg: runtimeCfg,
        agentId: route.agentId,
      }).provider,
    });
    if (storedOverride) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: storedOverride.provider
          ? `${storedOverride.provider}/${storedOverride.model}`
          : storedOverride.model,
      };
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        storePath,
        model: `${provider}/${model}`,
      };
    }
    const modelCfg = runtimeCfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      storePath,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
    };
  };

  const resolvePromptContextAmbientWatermark = (params: {
    chatId: number | string;
    isGroup: boolean;
    resolvedThreadId?: number;
    sessionKey: string;
    storePath: string;
  }): TelegramAmbientTranscriptWatermark | undefined => {
    if (!params.isGroup) {
      return undefined;
    }
    const key = (
      telegramDeps.resolveAmbientTranscriptWatermarkKey ?? resolveAmbientTranscriptWatermarkKey
    )({
      channel: "telegram",
      accountId,
      conversationId: String(params.chatId),
      ...(params.resolvedThreadId !== undefined ? { threadId: params.resolvedThreadId } : {}),
    });
    return (telegramDeps.readAmbientTranscriptWatermark ?? readAmbientTranscriptWatermark)({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      key,
    });
  };

  const recordMessageForReplyChain = (msg: Message, threadId?: number, botUserId?: number) =>
    messageCache.record({
      accountId,
      chatId: msg.chat.id,
      msg,
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(threadId != null ? { threadId } : {}),
    });

  const buildReplyChainForMessage = (msg: Message) =>
    buildTelegramReplyChain({
      cache: messageCache,
      accountId,
      chatId: msg.chat.id,
      msg,
    });

  const toReplyChainEntry = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    media?: TelegramMediaRef,
  ): TelegramReplyChainEntry => {
    const {
      sourceMessage: _sourceMessage,
      promptContextProjectionMarker: _promptContextProjectionMarker,
      ...entry
    } = node;
    const projectedEntry = { ...entry, sender: resolvePromptSender(node, ctx) };
    if (!media?.path) {
      return projectedEntry;
    }
    const { mediaRef: _mediaRef, ...entryWithoutProviderMediaRef } = projectedEntry;
    return {
      ...entryWithoutProviderMediaRef,
      mediaPath: media.path,
      ...(media?.contentType ? { mediaType: media.contentType } : {}),
    };
  };

  const toPromptContextMessage = (
    node: TelegramCachedMessageNode,
    ctx: TelegramContext,
    flags?: { replyTarget?: boolean },
    media?: TelegramMediaRef,
  ) => ({
    message_id: node.messageId,
    thread_id: node.threadId,
    sender: resolvePromptSender(node, ctx),
    sender_id: node.senderId,
    sender_username: node.senderUsername,
    timestamp_ms: node.timestamp,
    body: node.body,
    media_type: media?.contentType ?? node.mediaType,
    media_path: media?.path,
    media_ref: media?.path ? undefined : node.mediaRef,
    reply_to_id: node.replyToId,
    is_reply_target: flags?.replyTarget === true ? true : undefined,
  });

  const buildPromptContextForMessage = async (
    ctx: TelegramContext,
    msg: Message,
    replyChainNodes: TelegramCachedMessageNode[],
    runtimeCfg: OpenClawConfig,
    runtimeTelegramCfg: TelegramAccountConfig,
    options?: TelegramMessageContextOptions,
    mediaByMessageId?: ReadonlyMap<string, TelegramMediaRef>,
    selectedMessageIds?: TelegramPromptContextMessageSelection,
  ): Promise<TelegramPromptContextEntry[]> => {
    const currentBotUserId = ctx.me?.id ?? opts.botInfo?.id;
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const groupHistoryLimit = Math.max(
      0,
      runtimeTelegramCfg.historyLimit ??
        runtimeCfg.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );
    const messageId = typeof msg.message_id === "number" ? String(msg.message_id) : undefined;
    const currentNode = await messageCache.get({
      accountId,
      chatId: msg.chat.id,
      messageId,
    });
    const threadId = currentNode?.threadId ? Number(currentNode.threadId) : undefined;
    const sessionBeforeTimestampMs =
      options?.receivedAtMs ?? (msg.date ? msg.date * 1000 : undefined);
    const isSessionBoundaryMessage = isTelegramSessionBoundaryCommandText(
      getTelegramTextParts(msg).text,
    );
    const sessionPromptEntries =
      isGroup || isSessionBoundaryMessage
        ? []
        : await buildTelegramSessionTranscriptPromptEntries({
            ...resolveTelegramSessionState({
              chatId: msg.chat.id,
              isGroup: false,
              isForum: false,
              messageThreadId: msg.message_thread_id,
              botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(ctx.me),
              senderId: msg.from?.id,
              runtimeCfg,
            }),
            limit: 10,
            ...(sessionBeforeTimestampMs !== undefined
              ? { beforeTimestampMs: sessionBeforeTimestampMs }
              : {}),
            ...(options?.promptContextMinTimestampMs !== undefined
              ? { minTimestampMs: options.promptContextMinTimestampMs }
              : {}),
          });
    const conversationContext =
      isGroup && groupHistoryLimit <= 0
        ? []
        : await buildTelegramConversationContext({
            cache: messageCache,
            messageId,
            accountId,
            chatId: msg.chat.id,
            ...(Number.isFinite(threadId) ? { threadId } : {}),
            replyChainNodes,
            recentLimit: isGroup ? groupHistoryLimit : 10,
            replyTargetWindowSize: 2,
            ...(options?.promptContextMinTimestampMs !== undefined
              ? { minTimestampMs: options.promptContextMinTimestampMs }
              : {}),
            ...(isGroup && options?.promptContextAmbientWatermark !== undefined
              ? {
                  includeNode: (
                    node: TelegramCachedMessageNode,
                    flags?: { replyTarget?: boolean },
                  ) =>
                    // Explicit reply targets stay visible so the current turn is not shown
                    // as a reply to invisible transcript-owned text.
                    flags?.replyTarget === true ||
                    isTelegramHistoryEntryAfterAmbientWatermark(
                      node,
                      options.promptContextAmbientWatermark,
                    ),
                }
              : {}),
          });
    const conversationContextById = new Map(
      conversationContext.flatMap((entry) =>
        entry.node.messageId ? [[entry.node.messageId, entry] as const] : [],
      ),
    );
    for (const [selectedMessageId, selection] of selectedMessageIds ?? []) {
      if (selection === "exclude") {
        conversationContextById.delete(selectedMessageId);
        continue;
      }
      if (selectedMessageId === messageId || conversationContextById.has(selectedMessageId)) {
        continue;
      }
      const node = await messageCache.get({
        accountId,
        chatId: msg.chat.id,
        messageId: selectedMessageId,
      });
      if (node?.messageId) {
        conversationContextById.set(node.messageId, { node });
      }
    }
    const cachePromptMessageEntries = Array.from(conversationContextById.values()).map((entry) => ({
      node: entry.node,
      message: toPromptContextMessage(
        entry.node,
        ctx,
        { replyTarget: entry.isReplyTarget },
        entry.node.messageId ? mediaByMessageId?.get(entry.node.messageId) : undefined,
      ),
    }));
    const cachePromptMessages = cachePromptMessageEntries.map((entry) => entry.message);
    const inboundCacheTextKeys = new Set<string>();
    const legacyOutboundCacheTextKeys = new Set<string>();
    for (const entry of cachePromptMessageEntries) {
      const key = resolvePromptContextTextDedupeKey(entry.message);
      if (key === undefined) {
        continue;
      }
      if (hasLegacyPromptContextTimestamp(entry.node, currentBotUserId)) {
        legacyOutboundCacheTextKeys.add(key);
      } else if (!isTelegramMessageFromCurrentBot(entry.node.sourceMessage, currentBotUserId)) {
        inboundCacheTextKeys.add(key);
      }
    }
    const completeProjectionIds = resolveCompleteTelegramPromptContextProjectionIds(
      cachePromptMessageEntries.map((entry) => entry.node.promptContextProjectionMarker),
    );
    const sessionOnlyPromptMessages = sessionPromptEntries.flatMap((entry) => {
      if (entry.role === "assistant") {
        if (entry.transcriptMessageId && completeProjectionIds.has(entry.transcriptMessageId)) {
          return [];
        }
        // Shipped pre-projection outbound rows carried an explicit transcript
        // timestamp. Preserve that exact legacy dedupe without treating other
        // markerless or invalid rows as projection provenance.
        const key = resolvePromptContextTextDedupeKey(entry.message);
        return key !== undefined && legacyOutboundCacheTextKeys.has(key) ? [] : [entry.message];
      }
      const key = resolvePromptContextTextDedupeKey(entry.message);
      return key !== undefined && inboundCacheTextKeys.has(key) ? [] : [entry.message];
    });
    const promptMessages = [...sessionOnlyPromptMessages, ...cachePromptMessages].toSorted(
      (left, right) => (left.timestamp_ms ?? 0) - (right.timestamp_ms ?? 0),
    );
    return promptMessages.length > 0
      ? [
          {
            label: "Conversation context",
            source: sessionOnlyPromptMessages.length > 0 ? "session" : "telegram",
            type: "chat_window",
            payload: {
              order: "chronological",
              relation: "selected_for_current_message",
              messages: promptMessages,
            },
          },
        ]
      : [];
  };

  const resolveReplyMediaForChain = async (
    ctx: TelegramContext,
    chain: TelegramCachedMessageNode[],
    shouldHydrateMedia: (node: TelegramCachedMessageNode, index: number) => Promise<boolean>,
    durableMediaReplay: boolean,
  ): Promise<{ replyMedia: TelegramMediaRef[]; replyChain: TelegramReplyChainEntry[] }> => {
    const replyMedia: TelegramMediaRef[] = [];
    const replyChain: TelegramReplyChainEntry[] = [];
    for (const [index, node] of chain.entries()) {
      let mediaRef: TelegramMediaRef | undefined;
      const replyFileId = resolveInboundMediaFileId(node.sourceMessage);
      if (
        replyFileId &&
        hasInboundMedia(node.sourceMessage) &&
        (await shouldHydrateMedia(node, index))
      ) {
        try {
          const media = await resolveMedia({
            ctx: {
              message: node.sourceMessage,
              me: ctx.me,
              getFile: async (signal) => await bot.api.getFile(replyFileId, signal),
            },
            maxBytes: mediaMaxBytes,
            ...mediaRuntimeWithAbort,
          });
          mediaRef = media
            ? {
                path: media.path,
                ...(media.contentType ? { contentType: media.contentType } : {}),
                ...(media.stickerMetadata ? { stickerMetadata: media.stickerMetadata } : {}),
              }
            : undefined;
        } catch (err) {
          // Only durable ingress can replay a reply-media abort. Live polling must
          // preserve the current text instead of acknowledging it without dispatch.
          if (mediaRuntimeWithAbort.abortSignal?.aborted && durableMediaReplay) {
            recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
            throw err;
          }
          logger.warn(
            { chatId: ctx.message.chat.id, error: String(err) },
            "reply media fetch failed",
          );
        }
      }
      if (mediaRef) {
        replyMedia.push(mediaRef);
      }
      replyChain.push(toReplyChainEntry(node, ctx, mediaRef));
    }
    return { replyMedia, replyChain };
  };

  const processMessageWithReplyChain = async (params: {
    ctx: TelegramContext;
    msg: Message;
    allMedia: TelegramMediaRef[];
    promptContextMessageSelection?: TelegramPromptContextMessageSelection;
    storeAllowFrom: string[];
    options?: TelegramMessageContextOptions;
    dispatchDedupeKeys?: string[];
    spooledReplayParticipants?: readonly TelegramSpooledReplayDeferredParticipant[];
    spooledReplayAbortSignal?: AbortSignal;
  }): Promise<TelegramMessageProcessingResult> => {
    let dispatchDedupeCommitted = false;
    let spooledReplayFinalResult: TelegramMessageProcessingResult | undefined;
    let spooledReplayFinalization: Promise<TelegramMessageProcessingResult> | undefined;
    // Callback-submit retries also set options.spooledReplay without durable ingress.
    // Media aborts retry only when the update frame or a buffered participant owns replay.
    const durableMediaReplay =
      isTelegramSpooledReplayUpdate(params.ctx.update) ||
      Boolean(params.spooledReplayParticipants?.length);
    const spooledReplay = params.options?.spooledReplay === true || durableMediaReplay;
    const explicitParticipants = params.spooledReplayParticipants ?? [];
    const frameParticipant =
      spooledReplay &&
      explicitParticipants.length === 0 &&
      params.options?.isolateSpooledReplaySettlement !== true
        ? (getTelegramSpooledReplayDeferredParticipant() ??
          createTelegramSpooledReplayDeferredParticipant(
            `message:${params.msg.chat.id}:${params.msg.message_id}`,
          ) ??
          undefined)
        : undefined;
    const ingressSpooledReplayParticipants = [
      ...explicitParticipants,
      ...(frameParticipant ? [frameParticipant] : []),
    ];
    const processingParticipant =
      explicitParticipants.length > 0
        ? createTelegramSpooledReplayParticipant(
            `message-processing:${params.msg.chat.id}:${params.msg.message_id}`,
          )
        : frameParticipant;
    if (processingParticipant && explicitParticipants.length > 0) {
      for (const participant of explicitParticipants) {
        void participant.task.then((result) => {
          processingParticipant.settle(result);
        });
      }
    }
    const spooledReplayParticipants = [
      ...new Set([
        ...ingressSpooledReplayParticipants,
        ...(processingParticipant ? [processingParticipant] : []),
      ]),
    ];
    const finalizeSpooledReplayResult = async (
      result: TelegramMessageProcessingResult,
    ): Promise<TelegramMessageProcessingResult> => {
      if (spooledReplayFinalResult) {
        return spooledReplayFinalResult;
      }
      if (spooledReplayFinalization) {
        return await spooledReplayFinalization;
      }
      const finalization = (async () => {
        const finalized = result;
        if (result.kind === "completed") {
          // Do not cache or settle a durable-adoption failure. Deferred queue
          // ownership retries this callback with the same spool participants.
          const releaseSettlementHolds = beginSpooledReplaySettlementHolds(
            ingressSpooledReplayParticipants,
          );
          try {
            await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? [], {
              requirePersistent: true,
            });
          } catch (error) {
            releaseSettlementHolds("replay-pending");
            throw error;
          }
          releaseSettlementHolds("discard-pending");
          dispatchDedupeCommitted = true;
        } else {
          releaseDispatchDedupeKeys(
            params.dispatchDedupeKeys ?? [],
            result.kind === "failed-retryable" ? result.error : undefined,
          );
        }
        spooledReplayFinalResult = finalized;
        settleSpooledReplayParticipants(spooledReplayParticipants, finalized);
        return finalized;
      })();
      spooledReplayFinalization = finalization;
      try {
        return await finalization;
      } finally {
        if (!spooledReplayFinalResult && spooledReplayFinalization === finalization) {
          spooledReplayFinalization = undefined;
        }
      }
    };
    try {
      // One assembled turn owns one config identity. Reloading below this point
      // can validate a model pin against a different allowlist than dispatch uses.
      const runtimeCfg = telegramDeps.getRuntimeConfig();
      const runtimeTelegramCfg = resolveTelegramAccount({ cfg: runtimeCfg, accountId }).config;
      const replyChainNodes = await buildReplyChainForMessage(params.msg);
      const isGroupConversation =
        params.msg.chat.type === "group" || params.msg.chat.type === "supergroup";
      const isForum =
        params.msg.chat.type === "supergroup" &&
        Boolean(params.msg.chat.is_forum || params.msg.is_topic_message);
      const scopedThreadId = resolveTelegramForumThreadId({
        isForum,
        messageThreadId: params.msg.message_thread_id,
      });
      const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
        runtimeTelegramCfg,
        params.msg.chat.id,
        scopedThreadId,
      );
      const scopedAllowFrom = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
      const configuredGroupAllowFrom =
        scopedAllowFrom ??
        opts.groupAllowFrom ??
        runtimeTelegramCfg.groupAllowFrom ??
        runtimeTelegramCfg.allowFrom ??
        opts.allowFrom;
      const contextVisibilityMode = resolveChannelContextVisibilityMode({
        cfg: runtimeCfg,
        channel: "telegram",
        accountId,
      });
      const shouldHydrateReplyMedia = async (
        node: TelegramCachedMessageNode,
        index: number,
      ): Promise<boolean> => {
        if (!isGroupConversation) {
          return true;
        }
        const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
          cfg: runtimeCfg,
          allowFrom: configuredGroupAllowFrom,
          accountId,
          senderId: node.senderId,
        });
        const effectiveAllow = normalizeAllowFrom(expandedAllowFrom);
        const senderAllowed = effectiveAllow.hasEntries
          ? isSenderAllowed({
              allow: effectiveAllow,
              senderId: node.senderId,
              senderUsername: node.senderUsername,
            })
          : true;
        return evaluateSupplementalContextVisibility({
          mode: contextVisibilityMode,
          kind: index === 0 ? "quote" : "thread",
          senderAllowed,
        }).include;
      };
      const { replyMedia, replyChain } = await resolveReplyMediaForChain(
        params.ctx,
        replyChainNodes,
        shouldHydrateReplyMedia,
        durableMediaReplay,
      );
      const promptContextMediaByMessageId = new Map<string, TelegramMediaRef>();
      const currentMessageId =
        typeof params.msg.message_id === "number" ? String(params.msg.message_id) : undefined;
      for (const [index, media] of params.allMedia.entries()) {
        const messageId = media.sourceMessageId ?? (index === 0 ? currentMessageId : undefined);
        const promptMediaPath = media.path ? resolveTelegramPromptMediaPath(media.path) : undefined;
        if (messageId && promptMediaPath) {
          promptContextMediaByMessageId.set(messageId, {
            ...media,
            path: promptMediaPath,
          });
        }
      }
      for (const entry of replyChain) {
        const promptMediaPath = entry.mediaPath
          ? resolveTelegramPromptMediaPath(entry.mediaPath)
          : undefined;
        if (entry.messageId && entry.mediaPath && promptMediaPath) {
          promptContextMediaByMessageId.set(entry.messageId, {
            path: promptMediaPath,
            ...(entry.mediaType ? { contentType: entry.mediaType } : {}),
          });
        }
      }
      const promptContext = await buildPromptContextForMessage(
        params.ctx,
        params.msg,
        replyChainNodes,
        runtimeCfg,
        runtimeTelegramCfg,
        params.options,
        promptContextMediaByMessageId,
        params.promptContextMessageSelection,
      );
      const result = await processMessage(
        params.ctx,
        params.allMedia,
        params.storeAllowFrom,
        {
          cfg: runtimeCfg,
          telegramCfg: runtimeTelegramCfg,
          onDispatchStart: async () => {
            await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
            dispatchDedupeCommitted = true;
          },
          spooledReplayAbortSignal: params.spooledReplayAbortSignal,
          spooledReplayParticipant: processingParticipant,
          finalizeSpooledReplayResult: async (processingResult) =>
            await finalizeSpooledReplayResult(processingResult),
          completeSpooledReplayAfterIrrevocableAdoption: async () => {
            const completed = { kind: "completed" } satisfies TelegramMessageProcessingResult;
            return await finalizeSpooledReplayResult(completed);
          },
        },
        params.options,
        replyMedia,
        replyChain,
        promptContext,
      );
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(result);
      }
      if (result.kind === "completed" && !dispatchDedupeCommitted) {
        await commitDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
      } else if (result.kind !== "completed" && !dispatchDedupeCommitted) {
        releaseDispatchDedupeKeys(params.dispatchDedupeKeys ?? []);
      }
      return result;
    } catch (err) {
      if (spooledReplay) {
        return await finalizeSpooledReplayResult(buildFailedProcessingResult(err));
      }
      if (!dispatchDedupeCommitted) {
        releaseDispatchDedupeKeys(params.dispatchDedupeKeys ?? [], err);
      }
      throw err;
    }
  };

  return {
    mediaRuntimeWithAbort,
    normalizePromptContextMinTimestampMs,
    promptContextBoundaryOptions,
    latestPromptContextMinTimestampMs,
    latestPromptContextAmbientWatermark,
    mergeDispatchDedupeKeys,
    releaseDispatchDedupeKeys,
    buildFailedProcessingResult,
    settleSpooledReplayParticipants,
    createSpooledReplayParticipantForBufferedWork,
    spooledReplayOptions,
    claimMessageDispatchDedupe,
    buildSyntheticTextMessage,
    buildSyntheticContext,
    formatTelegramAmbientTranscriptBody,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
    processMessageWithReplyChain,
  };
}

export type TelegramHandlerMessageRuntime = ReturnType<typeof createTelegramHandlerMessageRuntime>;
