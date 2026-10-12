import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import {
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
  type StatusReactionController,
} from "openclaw/plugin-sdk/channel-feedback";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import { resolveBotThreadMentionPolicy } from "openclaw/plugin-sdk/channel-mention-gating";
import type {
  TelegramDirectConfig,
  TelegramGroupConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { deriveLastRoutePolicy, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  expandTelegramAllowFromWithAccessGroups,
  resolveTelegramDmAllow,
} from "./access-groups.js";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { normalizeAllowFrom, resolveTelegramEffectiveDmPolicy } from "./bot-access.js";
import { resolveTelegramInboundBody } from "./bot-message-context.body.js";
import {
  buildTelegramInboundContextPayload,
  loadTelegramMessageContextSessionRuntime,
} from "./bot-message-context.session.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import {
  buildTypingThreadParams,
  extractTelegramForumFlag,
  resolveTelegramForumFlag,
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramMessageThreadSpec,
  resolveTelegramThreadSpec,
} from "./bot/helpers.js";
import {
  resolveTelegramConversationRoute,
  resolveTelegramTargetSession,
} from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import { resolveTelegramForumTopicMetadata } from "./forum-topic-metadata.js";
import { evaluateTelegramGroupBaseAccess } from "./group-access.js";
import { resolveTelegramNativeCommandAdmission } from "./ingress.js";
import {
  buildTelegramStatusReactionVariants,
  type TelegramReactionEmoji,
  resolveTelegramAllowedReactions,
  resolveTelegramReactionEmoji,
  resolveTelegramReactionVariant,
  resolveTelegramStatusReactionEmojis,
} from "./status-reaction-variants.js";

export type {
  BuildTelegramMessageContextParams,
  TelegramMediaRef,
} from "./bot-message-context.types.js";

const loadTelegramMessageContextRuntime = createLazyRuntimeModule(
  () => import("./bot-message-context.runtime.js"),
);

type TelegramMessageContextPayload = Awaited<ReturnType<typeof buildTelegramInboundContextPayload>>;
type TelegramStatusReactionController = Omit<StatusReactionController, "clear">;

export type TelegramMessageContext = {
  cfg: BuildTelegramMessageContextParams["cfg"];
  ctxPayload: TelegramMessageContextPayload["ctxPayload"];
  turn: TelegramMessageContextPayload["turn"];
  primaryCtx: BuildTelegramMessageContextParams["primaryCtx"];
  msg: BuildTelegramMessageContextParams["primaryCtx"]["message"];
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"];
  isGroup: boolean;
  groupConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["groupConfig"];
  topicConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["topicConfig"];
  resolvedThreadId?: number;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  replyThreadId?: number;
  isForum: boolean;
  historyKey?: string;
  historyLimit: BuildTelegramMessageContextParams["historyLimit"];
  route: Awaited<ReturnType<typeof resolveTelegramConversationRoute>>["route"];
  skillFilter: TelegramMessageContextPayload["skillFilter"];
  sendTyping: () => Promise<void>;
  sendRecordVoice: () => Promise<void>;
  sendChatActionHandler: BuildTelegramMessageContextParams["sendChatActionHandler"];
  initialTypingCueSent?: boolean;
  ackReactionPromise: Promise<boolean> | null;
  statusReactionController: TelegramStatusReactionController | null;
  accountId: string;
};

export const buildTelegramMessageContext = async ({
  nativeCommandNames,
  primaryCtx,
  allMedia,
  replyMedia = [],
  replyChain = [],
  promptContext = [],
  storeAllowFrom,
  abortSignal,
  options,
  bot,
  cfg,
  account,
  ownerAgentId,
  historyLimit,
  dmHistoryLimit,
  dmPolicy,
  allowFrom,
  groupAllowFrom,
  ackReactionScope,
  logger,
  resolveGroupActivation,
  resolveGroupRequireMention,
  resolveTelegramGroupConfig,
  runtime,
  sessionRuntime,
  upsertPairingRequest,
  sendChatActionHandler,
}: BuildTelegramMessageContextParams): Promise<TelegramMessageContext | null> => {
  const msg = primaryCtx.message;
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const senderId = msg.from?.id ? String(msg.from.id) : "";
  const isDirectMessagesChat = msg.chat.is_direct_messages === true;
  const isForum = isDirectMessagesChat
    ? false
    : await resolveTelegramForumFlag({
        chatId,
        chatType: msg.chat.type,
        isGroup,
        isForum: extractTelegramForumFlag(msg.chat),
        isTopicMessage: msg.is_topic_message,
        getChat: (id) => bot.api.getChat(id),
      });
  const threadSpec = options?.threadSpec ?? resolveTelegramMessageThreadSpec(msg, isForum);
  const resolvedThreadId =
    threadSpec.scope === "forum" || threadSpec.scope === "direct-messages"
      ? threadSpec.id
      : undefined;
  const replyThreadId = threadSpec.id;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : undefined;
  let topicName: string | undefined;
  let isBotOwnedThread = false;
  if (isForum && resolvedThreadId != null) {
    const topicRuntime = await loadTelegramMessageContextSessionRuntime(sessionRuntime);
    const topicNameCacheScope = topicRuntime.resolveStorePath(cfg.session?.store, {
      agentId:
        ownerAgentId?.trim() ||
        resolveTelegramAccountOwnerAgentId({ cfg, accountId: account.accountId }),
    });
    const topic = await resolveTelegramForumTopicMetadata({
      msg,
      threadId: resolvedThreadId,
      scope: topicNameCacheScope,
    });
    topicName = topic.topicName;
    isBotOwnedThread = primaryCtx.me?.id !== undefined && topic.creatorUserId === primaryCtx.me.id;
  }

  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, threadIdForConfig, cfg);
  const directConfig = !isGroup ? (groupConfig as TelegramDirectConfig | undefined) : undefined;
  const telegramGroupConfig = isGroup
    ? (groupConfig as TelegramGroupConfig | undefined)
    : undefined;
  const effectiveDmPolicy = resolveTelegramEffectiveDmPolicy({
    isGroup,
    groupConfig,
    dmPolicy,
  });
  const conversationRoute = await resolveTelegramConversationRoute({
    cfg,
    accountId: account.accountId,
    chatId,
    isGroup,
    threadSpec,
    senderId,
    topicAgentId: topicConfig?.agentId,
  });
  const { bindingMode } = conversationRoute;
  let { route } = conversationRoute;
  const isNamedAccountFallback =
    normalizeAccountId(route.accountId) !==
      normalizeAccountId(resolveDefaultTelegramAccountId(cfg)) && route.matchedBy === "default";
  const hasExplicitTopicRoute = isGroup && Boolean(topicConfig?.agentId?.trim());
  if (isNamedAccountFallback && isGroup && !hasExplicitTopicRoute) {
    logInboundDrop({
      log: logVerbose,
      channel: "telegram",
      reason: "non-default account requires explicit binding",
      target: route.accountId,
    });
    return null;
  }
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const dmAllow = await resolveTelegramDmAllow({
    cfg,
    groupAllowOverride,
    allowFrom,
    accountId: account.accountId,
    senderId,
    storeAllowFrom,
    dmPolicy: effectiveDmPolicy,
  });
  const expandedGroupAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg,
    allowFrom: groupAllowOverride ?? groupAllowFrom,
    accountId: account.accountId,
    senderId,
  });
  const effectiveGroupAllow = normalizeAllowFrom(expandedGroupAllowFrom);
  const hasGroupAllowOverride = groupAllowOverride !== undefined;
  const senderUsername = msg.from?.username ?? "";
  const commandAuthorizedByConfig = await resolveTelegramNativeCommandAdmission({
    msg,
    nativeCommandNames,
    botUsername: primaryCtx.me?.username,
    cfg,
    accountId: account.accountId,
    dmPolicy: effectiveDmPolicy,
    isGroup,
    chatId,
    senderId,
  });
  const baseAccess = evaluateTelegramGroupBaseAccess({
    groupConfig,
    topicConfig,
    hasGroupAllowOverride,
    effectiveGroupAllow,
    senderId,
    enforceAllowOverride: true,
    requireSenderForAllowOverride: false,
  });
  if (!baseAccess.allowed) {
    logVerbose(
      {
        "group-disabled": `Blocked telegram group ${chatId} (group disabled)`,
        "topic-disabled": `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`,
        "group-override-unauthorized": isGroup
          ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`
          : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`,
      }[baseAccess.reason],
    );
    return null;
  }

  if (!isGroup && directConfig?.requireTopic === true && dmThreadId == null) {
    logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
    return null;
  }

  const sendChatAction = async (action: "typing" | "record_voice") => {
    if (threadSpec.scope === "direct-messages") {
      return;
    }
    await withTelegramApiErrorLogging({
      operation: "sendChatAction",
      fn: () =>
        sendChatActionHandler.sendChatAction(
          chatId,
          action,
          buildTypingThreadParams(replyThreadId),
        ),
    });
  };
  const sendTyping = () => sendChatAction("typing");

  const sendRecordVoice = async () => {
    try {
      await sendChatAction("record_voice");
    } catch (err) {
      logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
    }
  };

  if (
    !commandAuthorizedByConfig &&
    !(await enforceTelegramDmAccess({
      isGroup,
      dmPolicy: effectiveDmPolicy,
      msg,
      chatId,
      effectiveDmAllow: dmAllow.effectiveAllow,
      accountId: account.accountId,
      bot,
      logger,
      upsertPairingRequest,
    }))
  ) {
    return null;
  }

  const sessionKey = resolveTelegramTargetSession({
    cfg,
    route,
    chatId,
    isGroup,
    senderId,
    dmThreadId,
    botHasTopicsEnabled:
      (threadSpec.scope === "dm" && msg.is_topic_message === true) ||
      resolveTelegramBotHasTopicsEnabled(primaryCtx.me),
  });
  route = {
    ...route,
    sessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey: route.mainSessionKey,
    }),
  };
  const activationOverride = await resolveGroupActivation({
    sessionKey,
    agentId: route.agentId,
    cfg,
  });
  const baseRequireMention = resolveGroupRequireMention(chatId, cfg);
  // Persisted session activation intentionally interleaves topic and group config.
  // ScopeTree resolves config only, so this precedence remains session-owned here.
  const configuredGroupRequireMention = firstDefined(
    topicConfig?.requireMention,
    activationOverride,
    telegramGroupConfig?.requireMention,
    baseRequireMention,
  );
  const requireMentionInBotThreads = firstDefined(
    topicConfig?.requireMentionInBotThreads,
    telegramGroupConfig?.requireMentionInBotThreads,
  );
  const { requireMention: groupRequireMention } = resolveBotThreadMentionPolicy({
    isBotOwnedThread,
    requireMentionInBotThreads,
    requireMention: Boolean(configuredGroupRequireMention),
  });
  const requireMention =
    isGroup && bindingMode.kind === "plugin-owned-runtime" ? false : groupRequireMention;

  const recordChannelActivity =
    runtime?.recordChannelActivity ??
    (await loadTelegramMessageContextRuntime()).recordChannelActivity;
  recordChannelActivity({
    channel: "telegram",
    accountId: account.accountId,
    direction: "inbound",
  });

  const inboundContext = {
    cfg,
    primaryCtx,
    msg,
    allMedia,
    isGroup,
    chatId,
    senderId,
    senderUsername,
    resolvedThreadId,
    threadSpec,
    effectiveGroupAllow,
    groupConfig,
    topicConfig,
    abortSignal,
    options,
  };
  const bodyResult = await resolveTelegramInboundBody({
    ...inboundContext,
    nativeCommandNames,
    accountId: account.accountId,
    routeAgentId: route.agentId,
    sessionKey,
    acpBinding: bindingMode.kind === "configured",
    effectiveDmAllow: dmAllow.effectiveAllow,
    providerMentionPatterns: cfg.channels?.telegram?.accounts?.[account.accountId]?.mentionPatterns,
    requireMention,
    isBotOwnedThread,
    requireMentionInBotThreads,
    logger,
  });
  if (!bodyResult) {
    return null;
  }

  if (bindingMode.kind === "configured") {
    const ensureConfiguredBindingRouteReady =
      runtime?.ensureConfiguredBindingRouteReady ??
      (await loadTelegramMessageContextRuntime()).ensureConfiguredBindingRouteReady;
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg,
      bindingResolution: bindingMode.binding,
    });
    if (!ensured.ok) {
      logVerbose(
        `telegram: configured ACP binding unavailable for ${bindingMode.binding.record.conversation.conversationId}: ${ensured.error}`,
      );
      logInboundDrop({
        log: logVerbose,
        channel: "telegram",
        reason: "configured ACP binding unavailable",
        target: bindingMode.binding.record.conversation.conversationId,
      });
      return null;
    }
    logVerbose(
      `telegram: using configured ACP binding for ${bindingMode.binding.record.conversation.conversationId} -> ${bindingMode.sessionKey}`,
    );
  }

  // Send the first typing cue before expensive context/session construction,
  // but only after intake has accepted the message as a non-room-event turn.
  const initialTypingCueSent = bodyResult.inboundEventKind !== "room_event";
  if (initialTypingCueSent) {
    void sendTyping().catch((err: unknown) => {
      logVerbose(`telegram early typing cue failed for chat ${chatId}: ${String(err)}`);
    });
  }

  const { ctxPayload, skillFilter, turn } = await buildTelegramInboundContextPayload({
    ...inboundContext,
    replyMedia,
    replyChain,
    promptContext,
    isForum,
    dmThreadId,
    route,
    bodyResult,
    historyLimit,
    dmHistoryLimit,
    groupRequireMention,
    dmAllowFrom: dmAllow.allowFrom,
    topicName,
    sessionRuntime,
  });
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "telegram",
    accountId: account.accountId,
  });
  const ackReactionEmoji = ackReaction ? resolveTelegramReactionEmoji(ackReaction) : undefined;
  const shouldSendAckReaction = Boolean(
    ackReaction &&
    shouldAckReactionGate({
      scope: ackReactionScope,
      inboundEventKind: ctxPayload.InboundEventKind,
      isDirect: !isGroup,
      isGroup,
      isMentionableGroup: isGroup,
      canDetectMention: bodyResult.canDetectMention,
      effectiveWasMentioned: bodyResult.effectiveWasMentioned,
      shouldBypassMention: bodyResult.shouldBypassMention,
    }),
  );
  const statusReactionsConfig = cfg.messages?.statusReactions;
  const statusReactionsEnabled =
    ctxPayload.InboundEventKind !== "room_event" &&
    statusReactionsConfig?.enabled === true &&
    shouldSendAckReaction;
  const resolvedStatusReactionEmojis = statusReactionsEnabled
    ? resolveTelegramStatusReactionEmojis({
        initialEmoji: ackReaction,
        overrides: undefined,
      })
    : null;
  const statusReactionVariantsByEmoji = resolvedStatusReactionEmojis
    ? buildTelegramStatusReactionVariants(resolvedStatusReactionEmojis)
    : new Map<string, string[]>();
  let allowedStatusReactionEmojisPromise: Promise<Set<TelegramReactionEmoji> | null> | null = null;
  const statusReactionController: TelegramStatusReactionController | null =
    statusReactionsEnabled && resolvedStatusReactionEmojis && msg.message_id
      ? (
          runtime?.createStatusReactionController ??
          (await loadTelegramMessageContextRuntime()).createStatusReactionController
        )({
          enabled: true,
          adapter: {
            setReaction: async (emoji: string) => {
              if (!allowedStatusReactionEmojisPromise) {
                allowedStatusReactionEmojisPromise = resolveTelegramAllowedReactions({
                  chat: msg.chat,
                  chatId,
                  getChat: (id) => bot.api.getChat(id),
                })
                  .then((reactions) =>
                    reactions
                      ? new Set(
                          reactions.flatMap((reaction) =>
                            reaction.type === "emoji" ? [reaction.emoji] : [],
                          ),
                        )
                      : null,
                  )
                  .catch((err: unknown) => {
                    logVerbose(
                      `telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(err)}`,
                    );
                    return null;
                  });
              }
              const allowedStatusReactionEmojis = await allowedStatusReactionEmojisPromise;
              const resolvedEmoji = resolveTelegramReactionVariant({
                requestedEmoji: emoji,
                variantsByRequestedEmoji: statusReactionVariantsByEmoji,
                allowedEmojiReactions: allowedStatusReactionEmojis,
              });
              if (!resolvedEmoji) {
                return;
              }
              await bot.api.setMessageReaction(chatId, msg.message_id, [
                { type: "emoji", emoji: resolvedEmoji },
              ]);
            },
          },
          initialEmoji: ackReaction,
          emojis: resolvedStatusReactionEmojis,
          onError: (err) => {
            logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
          },
        })
      : null;

  const ackReactionPromise: Promise<boolean> | null = statusReactionController
    ? Promise.resolve(statusReactionController.setQueued()).then(
        () => true,
        () => false,
      )
    : shouldSendAckReaction && msg.message_id && ackReactionEmoji
      ? withTelegramApiErrorLogging({
          operation: "setMessageReaction",
          fn: () =>
            bot.api.setMessageReaction(chatId, msg.message_id, [
              { type: "emoji", emoji: ackReactionEmoji },
            ]),
        }).then(
          () => true,
          (err: unknown) => {
            logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
            return false;
          },
        )
      : null;

  return {
    cfg,
    ctxPayload,
    turn,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    groupConfig,
    topicConfig,
    resolvedThreadId,
    threadSpec,
    replyThreadId,
    isForum,
    historyKey: bodyResult.historyKey ?? "",
    historyLimit,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    sendChatActionHandler,
    initialTypingCueSent,
    ackReactionPromise,
    statusReactionController,
    accountId: account.accountId,
  };
};
