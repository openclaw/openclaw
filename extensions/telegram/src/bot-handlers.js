import { resolveAgentDir, resolveDefaultAgentId } from "../../../src/agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs
} from "../../../src/auto-reply/inbound-debounce.js";
import { buildCommandsPaginationKeyboard } from "../../../src/auto-reply/reply/commands-info.js";
import {
  buildModelsProviderData,
  formatModelsAvailableHeader
} from "../../../src/auto-reply/reply/commands-models.js";
import { resolveStoredModelOverride } from "../../../src/auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../../../src/auto-reply/skill-commands.js";
import { buildCommandsMessagePaginated } from "../../../src/auto-reply/status.js";
import { shouldDebounceTextInbound } from "../../../src/channels/inbound-debounce-policy.js";
import { resolveChannelConfigWrites } from "../../../src/channels/plugins/config-writes.js";
import { loadConfig } from "../../../src/config/config.js";
import { writeConfigFile } from "../../../src/config/io.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  updateSessionStore
} from "../../../src/config/sessions.js";
import { danger, logVerbose, warn } from "../../../src/globals.js";
import { enqueueSystemEvent } from "../../../src/infra/system-events.js";
import { MediaFetchError } from "../../../src/media/fetch.js";
import { readChannelAllowFromStore } from "../../../src/pairing/pairing-store.js";
import { resolveAgentRoute } from "../../../src/routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../../src/routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../../src/sessions/model-overrides.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import {
  isSenderAllowed,
  normalizeDmAllowFromWithStore
} from "./bot-access.js";
import {
  MEDIA_GROUP_TIMEOUT_MS
} from "./bot-updates.js";
import { resolveMedia } from "./bot/delivery.js";
import {
  getTelegramTextParts,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext
} from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";
import { enforceTelegramDmAccess } from "./dm-access.js";
import {
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  shouldEnableTelegramExecApprovalButtons
} from "./exec-approvals.js";
import {
  evaluateTelegramGroupBaseAccess,
  evaluateTelegramGroupPolicyAccess
} from "./group-access.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection
} from "./model-buttons.js";
import { buildInlineKeyboard } from "./send.js";
import { wasSentByBot } from "./sent-message-cache.js";
const APPROVE_CALLBACK_DATA_RE = /^\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+(allow-once|allow-always|deny)\b/i;
function isMediaSizeLimitError(err) {
  const errMsg = String(err);
  return errMsg.includes("exceeds") && errMsg.includes("MB limit");
}
function isRecoverableMediaGroupError(err) {
  return err instanceof MediaFetchError || isMediaSizeLimitError(err);
}
function hasInboundMedia(msg) {
  return Boolean(msg.media_group_id) || Array.isArray(msg.photo) && msg.photo.length > 0 || Boolean(msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker);
}
function hasReplyTargetMedia(msg) {
  const externalReply = msg.external_reply;
  const replyTarget = msg.reply_to_message ?? externalReply;
  return Boolean(replyTarget && hasInboundMedia(replyTarget));
}
function resolveInboundMediaFileId(msg) {
  return msg.sticker?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id ?? msg.video?.file_id ?? msg.video_note?.file_id ?? msg.document?.file_id ?? msg.audio?.file_id ?? msg.voice?.file_id;
}
const registerTelegramHandlers = ({
  cfg,
  accountId,
  bot,
  opts,
  telegramTransport,
  runtime,
  mediaMaxBytes,
  telegramCfg,
  allowFrom,
  groupAllowFrom,
  resolveGroupPolicy,
  resolveTelegramGroupConfig,
  shouldSkipUpdate,
  processMessage,
  logger
}) => {
  const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
  const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4e3;
  const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = typeof opts.testTimings?.textFragmentGapMs === "number" && Number.isFinite(opts.testTimings.textFragmentGapMs) ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs)) : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
  const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
  const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
  const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 5e4;
  const mediaGroupTimeoutMs = typeof opts.testTimings?.mediaGroupFlushMs === "number" && Number.isFinite(opts.testTimings.mediaGroupFlushMs) ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs)) : MEDIA_GROUP_TIMEOUT_MS;
  const mediaGroupBuffer = /* @__PURE__ */ new Map();
  let mediaGroupProcessing = Promise.resolve();
  const textFragmentBuffer = /* @__PURE__ */ new Map();
  let textFragmentProcessing = Promise.resolve();
  const debounceMs = resolveInboundDebounceMs({ cfg, channel: "telegram" });
  const FORWARD_BURST_DEBOUNCE_MS = 80;
  const resolveTelegramDebounceLane = (msg) => {
    const forwardMeta = msg;
    return forwardMeta.forward_origin ?? forwardMeta.forward_from ?? forwardMeta.forward_from_chat ?? forwardMeta.forward_sender_name ?? forwardMeta.forward_date ? "forward" : "default";
  };
  const buildSyntheticTextMessage = (params) => ({
    ...params.base,
    ...params.from ? { from: params.from } : {},
    text: params.text,
    caption: void 0,
    caption_entities: void 0,
    entities: void 0,
    ...params.date != null ? { date: params.date } : {}
  });
  const buildSyntheticContext = (ctx, message) => {
    const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
    return { message, me: ctx.me, getFile };
  };
  const inboundDebouncer = createInboundDebouncer({
    debounceMs,
    resolveDebounceMs: (entry) => entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs,
    buildKey: (entry) => entry.debounceKey,
    shouldDebounce: (entry) => {
      const text = entry.msg.text ?? entry.msg.caption ?? "";
      const hasDebounceableText = shouldDebounceTextInbound({
        text,
        cfg,
        commandOptions: { botUsername: entry.botUsername }
      });
      if (entry.debounceLane === "forward") {
        return hasDebounceableText || entry.allMedia.length > 0;
      }
      if (!hasDebounceableText) {
        return false;
      }
      return entry.allMedia.length === 0;
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        const replyMedia2 = await resolveReplyMediaForMessage(last.ctx, last.msg);
        await processMessage(last.ctx, last.allMedia, last.storeAllowFrom, void 0, replyMedia2);
        return;
      }
      const combinedText = entries.map((entry) => entry.msg.text ?? entry.msg.caption ?? "").filter(Boolean).join("\n");
      const combinedMedia = entries.flatMap((entry) => entry.allMedia);
      if (!combinedText.trim() && combinedMedia.length === 0) {
        return;
      }
      const first = entries[0];
      const baseCtx = first.ctx;
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date
      });
      const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : void 0;
      const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
      const replyMedia = await resolveReplyMediaForMessage(baseCtx, syntheticMessage);
      await processMessage(
        syntheticCtx,
        combinedMedia,
        first.storeAllowFrom,
        messageIdOverride ? { messageIdOverride } : void 0,
        replyMedia
      );
    },
    onError: (err, items) => {
      runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
      const chatId = items[0]?.msg.chat.id;
      if (chatId != null) {
        const threadId = items[0]?.msg.message_thread_id;
        void bot.api.sendMessage(
          chatId,
          "Something went wrong while processing your message. Please try again.",
          threadId != null ? { message_thread_id: threadId } : void 0
        ).catch((sendErr) => {
          logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
        });
      }
    }
  });
  const resolveTelegramSessionState = (params) => {
    const resolvedThreadId = params.resolvedThreadId ?? resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId
    });
    const dmThreadId = !params.isGroup ? params.messageThreadId : void 0;
    const topicThreadId = resolvedThreadId ?? dmThreadId;
    const { topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId);
    const { route } = resolveTelegramConversationRoute({
      cfg,
      accountId,
      chatId: params.chatId,
      isGroup: params.isGroup,
      resolvedThreadId,
      replyThreadId: topicThreadId,
      senderId: params.senderId,
      topicAgentId: topicConfig?.agentId
    });
    const baseSessionKey = route.sessionKey;
    const threadKeys = dmThreadId != null ? resolveThreadSessionKeys({ baseSessionKey, threadId: `${params.chatId}:${dmThreadId}` }) : null;
    const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
    const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
    const store = loadSessionStore(storePath);
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const storedOverride = resolveStoredModelOverride({
      sessionEntry: entry,
      sessionStore: store,
      sessionKey
    });
    if (storedOverride) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        model: storedOverride.provider ? `${storedOverride.provider}/${storedOverride.model}` : storedOverride.model
      };
    }
    const provider = entry?.modelProvider?.trim();
    const model = entry?.model?.trim();
    if (provider && model) {
      return {
        agentId: route.agentId,
        sessionEntry: entry,
        sessionKey,
        model: `${provider}/${model}`
      };
    }
    const modelCfg = cfg.agents?.defaults?.model;
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary
    };
  };
  const processMediaGroup = async (entry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const captionMsg = entry.messages.find((m) => m.msg.caption || m.msg.text);
      const primaryEntry = captionMsg ?? entry.messages[0];
      const allMedia = [];
      for (const { ctx } of entry.messages) {
        let media;
        try {
          media = await resolveMedia(ctx, mediaMaxBytes, opts.token, telegramTransport);
        } catch (mediaErr) {
          if (!isRecoverableMediaGroupError(mediaErr)) {
            throw mediaErr;
          }
          runtime.log?.(
            warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`)
          );
          continue;
        }
        if (media) {
          allMedia.push({
            path: media.path,
            contentType: media.contentType,
            stickerMetadata: media.stickerMetadata
          });
        }
      }
      const storeAllowFrom = await loadStoreAllowFrom();
      const replyMedia = await resolveReplyMediaForMessage(primaryEntry.ctx, primaryEntry.msg);
      await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom, void 0, replyMedia);
    } catch (err) {
      runtime.error?.(danger(`media group handler failed: ${String(err)}`));
    }
  };
  const flushTextFragments = async (entry) => {
    try {
      entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
      const first = entry.messages[0];
      const last = entry.messages.at(-1);
      if (!first || !last) {
        return;
      }
      const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
      if (!combinedText.trim()) {
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: first.msg,
        text: combinedText,
        date: last.msg.date ?? first.msg.date
      });
      const storeAllowFrom = await loadStoreAllowFrom();
      const baseCtx = first.ctx;
      await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, {
        messageIdOverride: String(last.msg.message_id)
      });
    } catch (err) {
      runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
    }
  };
  const queueTextFragmentFlush = async (entry) => {
    textFragmentProcessing = textFragmentProcessing.then(async () => {
      await flushTextFragments(entry);
    }).catch(() => void 0);
    await textFragmentProcessing;
  };
  const runTextFragmentFlush = async (entry) => {
    textFragmentBuffer.delete(entry.key);
    await queueTextFragmentFlush(entry);
  };
  const scheduleTextFragmentFlush = (entry) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      await runTextFragmentFlush(entry);
    }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
  };
  const loadStoreAllowFrom = async () => readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
  const resolveReplyMediaForMessage = async (ctx, msg) => {
    const replyMessage = msg.reply_to_message;
    if (!replyMessage || !hasInboundMedia(replyMessage)) {
      return [];
    }
    const replyFileId = resolveInboundMediaFileId(replyMessage);
    if (!replyFileId) {
      return [];
    }
    try {
      const media = await resolveMedia(
        {
          message: replyMessage,
          me: ctx.me,
          getFile: async () => await bot.api.getFile(replyFileId)
        },
        mediaMaxBytes,
        opts.token,
        telegramTransport
      );
      if (!media) {
        return [];
      }
      return [
        {
          path: media.path,
          contentType: media.contentType,
          stickerMetadata: media.stickerMetadata
        }
      ];
    } catch (err) {
      logger.warn({ chatId: msg.chat.id, error: String(err) }, "reply media fetch failed");
      return [];
    }
  };
  const isAllowlistAuthorized = (allow, senderId, senderUsername) => allow.hasWildcard || allow.hasEntries && isSenderAllowed({
    allow,
    senderId,
    senderUsername
  });
  const shouldSkipGroupMessage = (params) => {
    const {
      isGroup,
      chatId,
      chatTitle,
      resolvedThreadId,
      senderId,
      senderUsername,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      groupConfig,
      topicConfig
    } = params;
    const baseAccess = evaluateTelegramGroupBaseAccess({
      isGroup,
      groupConfig,
      topicConfig,
      hasGroupAllowOverride,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      enforceAllowOverride: true,
      requireSenderForAllowOverride: true
    });
    if (!baseAccess.allowed) {
      if (baseAccess.reason === "group-disabled") {
        logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
        return true;
      }
      if (baseAccess.reason === "topic-disabled") {
        logVerbose(
          `Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`
        );
        return true;
      }
      logVerbose(
        `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`
      );
      return true;
    }
    if (!isGroup) {
      return false;
    }
    const policyAccess = evaluateTelegramGroupPolicyAccess({
      isGroup,
      chatId,
      cfg,
      telegramCfg,
      topicConfig,
      groupConfig,
      effectiveGroupAllow,
      senderId,
      senderUsername,
      resolveGroupPolicy,
      enforcePolicy: true,
      useTopicAndGroupOverrides: true,
      enforceAllowlistAuthorization: true,
      allowEmptyAllowlistEntries: false,
      requireSenderForAllowlistAuthorization: true,
      checkChatAllowlist: true
    });
    if (!policyAccess.allowed) {
      if (policyAccess.reason === "group-policy-disabled") {
        logVerbose("Blocked telegram group message (groupPolicy: disabled)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-no-sender") {
        logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-empty") {
        logVerbose(
          "Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)"
        );
        return true;
      }
      if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
        logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
        return true;
      }
      logger.info({ chatId, title: chatTitle, reason: "not-allowed" }, "skipping group message");
      return true;
    }
    return false;
  };
  const TELEGRAM_EVENT_AUTH_RULES = {
    reaction: {
      enforceDirectAuthorization: true,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "reaction unauthorized by dm policy/allowlist",
      deniedGroupReason: "reaction unauthorized by group allowlist"
    },
    "callback-scope": {
      enforceDirectAuthorization: false,
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope"
    },
    "callback-allowlist": {
      enforceDirectAuthorization: true,
      // Group auth is already enforced by shouldSkipGroupMessage (group policy + allowlist).
      // An extra allowlist gate here would block users whose original command was authorized.
      enforceGroupAllowlistAuthorization: false,
      deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
      deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist"
    }
  };
  const resolveTelegramEventAuthorizationContext = async (params) => {
    const groupAllowContext = params.groupAllowContext ?? await resolveTelegramGroupAllowFromContext({
      chatId: params.chatId,
      accountId,
      isGroup: params.isGroup,
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
      groupAllowFrom,
      resolveTelegramGroupConfig
    });
    const effectiveDmPolicy = !params.isGroup && groupAllowContext.groupConfig && "dmPolicy" in groupAllowContext.groupConfig ? groupAllowContext.groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing" : telegramCfg.dmPolicy ?? "pairing";
    return { dmPolicy: effectiveDmPolicy, ...groupAllowContext };
  };
  const authorizeTelegramEventSender = (params) => {
    const { chatId, chatTitle, isGroup, senderId, senderUsername, mode, context } = params;
    const {
      dmPolicy,
      resolvedThreadId,
      storeAllowFrom,
      groupConfig,
      topicConfig,
      groupAllowOverride,
      effectiveGroupAllow,
      hasGroupAllowOverride
    } = context;
    const authRules = TELEGRAM_EVENT_AUTH_RULES[mode];
    const {
      enforceDirectAuthorization,
      enforceGroupAllowlistAuthorization,
      deniedDmReason,
      deniedGroupReason
    } = authRules;
    if (shouldSkipGroupMessage({
      isGroup,
      chatId,
      chatTitle,
      resolvedThreadId,
      senderId,
      senderUsername,
      effectiveGroupAllow,
      hasGroupAllowOverride,
      groupConfig,
      topicConfig
    })) {
      return { allowed: false, reason: "group-policy" };
    }
    if (!isGroup && enforceDirectAuthorization) {
      if (dmPolicy === "disabled") {
        logVerbose(
          `Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`
        );
        return { allowed: false, reason: "direct-disabled" };
      }
      if (dmPolicy !== "open") {
        const dmAllowFrom = groupAllowOverride ?? allowFrom;
        const effectiveDmAllow = normalizeDmAllowFromWithStore({
          allowFrom: dmAllowFrom,
          storeAllowFrom,
          dmPolicy
        });
        if (!isAllowlistAuthorized(effectiveDmAllow, senderId, senderUsername)) {
          logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
          return { allowed: false, reason: "direct-unauthorized" };
        }
      }
    }
    if (isGroup && enforceGroupAllowlistAuthorization) {
      if (!isAllowlistAuthorized(effectiveGroupAllow, senderId, senderUsername)) {
        logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
        return { allowed: false, reason: "group-unauthorized" };
      }
    }
    return { allowed: true };
  };
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }
      const chatId = reaction.chat.id;
      const messageId = reaction.message_id;
      const user = reaction.user;
      const senderId = user?.id != null ? String(user.id) : "";
      const senderUsername = user?.username ?? "";
      const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
      const isForum = reaction.chat.is_forum === true;
      const reactionMode = telegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") {
        return;
      }
      if (user?.is_bot) {
        return;
      }
      if (reactionMode === "own" && !wasSentByBot(chatId, messageId)) {
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum
      });
      const senderAuthorization = authorizeTelegramEventSender({
        chatId,
        chatTitle: reaction.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: "reaction",
        context: eventAuthContext
      });
      if (!senderAuthorization.allowed) {
        return;
      }
      if (!isGroup) {
        const requireTopic = eventAuthContext.groupConfig?.requireTopic;
        if (requireTopic === true) {
          logVerbose(
            `Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`
          );
          return;
        }
      }
      const oldEmojis = new Set(
        reaction.old_reaction.filter((r) => r.type === "emoji").map((r) => r.emoji)
      );
      const addedReactions = reaction.new_reaction.filter((r) => r.type === "emoji").filter((r) => !oldEmojis.has(r.emoji));
      if (addedReactions.length === 0) {
        return;
      }
      const senderName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username : void 0;
      const senderUsernameLabel = user?.username ? `@${user.username}` : void 0;
      let senderLabel = senderName;
      if (senderName && senderUsernameLabel) {
        senderLabel = `${senderName} (${senderUsernameLabel})`;
      } else if (!senderName && senderUsernameLabel) {
        senderLabel = senderUsernameLabel;
      }
      if (!senderLabel && user?.id) {
        senderLabel = `id:${user.id}`;
      }
      senderLabel = senderLabel || "unknown";
      const resolvedThreadId = isForum ? resolveTelegramForumThreadId({ isForum, messageThreadId: void 0 }) : void 0;
      const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
      const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
      const route = resolveAgentRoute({
        cfg: loadConfig(),
        channel: "telegram",
        accountId,
        peer: { kind: isGroup ? "group" : "direct", id: peerId },
        parentPeer
      });
      const sessionKey = route.sessionKey;
      for (const r of addedReactions) {
        const emoji = r.emoji;
        const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
        enqueueSystemEvent(text, {
          sessionKey,
          contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`
        });
        logVerbose(`telegram: reaction event enqueued: ${text}`);
      }
    } catch (err) {
      runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
    }
  });
  const processInboundMessage = async (params) => {
    const {
      ctx,
      msg,
      chatId,
      resolvedThreadId,
      dmThreadId,
      storeAllowFrom,
      sendOversizeWarning,
      oversizeLogMessage
    } = params;
    const text = typeof msg.text === "string" ? msg.text : void 0;
    const isCommandLike = (text ?? "").trim().startsWith("/");
    if (text && !isCommandLike) {
      const nowMs = Date.now();
      const senderId2 = msg.from?.id != null ? String(msg.from.id) : "unknown";
      const threadId = resolvedThreadId ?? dmThreadId;
      const key = `text:${chatId}:${threadId ?? "main"}:${senderId2}`;
      const existing = textFragmentBuffer.get(key);
      if (existing) {
        const last = existing.messages.at(-1);
        const lastMsgId = last?.msg.message_id;
        const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
        const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
        const timeGapMs = nowMs - lastReceivedAtMs;
        const canAppend = idGap > 0 && idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP && timeGapMs >= 0 && timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS;
        if (canAppend) {
          const currentTotalChars = existing.messages.reduce(
            (sum, m) => sum + (m.msg.text?.length ?? 0),
            0
          );
          const nextTotalChars = currentTotalChars + text.length;
          if (existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS && nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS) {
            existing.messages.push({ msg, ctx, receivedAtMs: nowMs });
            scheduleTextFragmentFlush(existing);
            return;
          }
        }
        clearTimeout(existing.timer);
        textFragmentBuffer.delete(key);
        textFragmentProcessing = textFragmentProcessing.then(async () => {
          await flushTextFragments(existing);
        }).catch(() => void 0);
        await textFragmentProcessing;
      }
      const shouldStart = text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS;
      if (shouldStart) {
        const entry = {
          key,
          messages: [{ msg, ctx, receivedAtMs: nowMs }],
          timer: setTimeout(() => {
          }, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS)
        };
        textFragmentBuffer.set(key, entry);
        scheduleTextFragmentFlush(entry);
        return;
      }
    }
    const mediaGroupId = msg.media_group_id;
    if (mediaGroupId) {
      const existing = mediaGroupBuffer.get(mediaGroupId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.messages.push({ msg, ctx });
        existing.timer = setTimeout(async () => {
          mediaGroupBuffer.delete(mediaGroupId);
          mediaGroupProcessing = mediaGroupProcessing.then(async () => {
            await processMediaGroup(existing);
          }).catch(() => void 0);
          await mediaGroupProcessing;
        }, mediaGroupTimeoutMs);
      } else {
        const entry = {
          messages: [{ msg, ctx }],
          timer: setTimeout(async () => {
            mediaGroupBuffer.delete(mediaGroupId);
            mediaGroupProcessing = mediaGroupProcessing.then(async () => {
              await processMediaGroup(entry);
            }).catch(() => void 0);
            await mediaGroupProcessing;
          }, mediaGroupTimeoutMs)
        };
        mediaGroupBuffer.set(mediaGroupId, entry);
      }
      return;
    }
    let media = null;
    try {
      media = await resolveMedia(ctx, mediaMaxBytes, opts.token, telegramTransport);
    } catch (mediaErr) {
      if (isMediaSizeLimitError(mediaErr)) {
        if (sendOversizeWarning) {
          const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime,
            fn: () => bot.api.sendMessage(chatId, `\u26A0\uFE0F File too large. Maximum size is ${limitMb}MB.`, {
              reply_to_message_id: msg.message_id
            })
          }).catch(() => {
          });
        }
        logger.warn({ chatId, error: String(mediaErr) }, oversizeLogMessage);
        return;
      }
      logger.warn({ chatId, error: String(mediaErr) }, "media fetch failed");
      await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime,
        fn: () => bot.api.sendMessage(chatId, "\u26A0\uFE0F Failed to download media. Please try again.", {
          reply_to_message_id: msg.message_id
        })
      }).catch(() => {
      });
      return;
    }
    const hasText = Boolean(getTelegramTextParts(msg).text.trim());
    if (msg.sticker && !media && !hasText) {
      logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
      return;
    }
    const allMedia = media ? [
      {
        path: media.path,
        contentType: media.contentType,
        stickerMetadata: media.stickerMetadata
      }
    ] : [];
    const senderId = msg.from?.id ? String(msg.from.id) : "";
    const conversationThreadId = resolvedThreadId ?? dmThreadId;
    const conversationKey = conversationThreadId != null ? `${chatId}:topic:${conversationThreadId}` : String(chatId);
    const debounceLane = resolveTelegramDebounceLane(msg);
    const debounceKey = senderId ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}:${debounceLane}` : null;
    await inboundDebouncer.enqueue({
      ctx,
      msg,
      allMedia,
      storeAllowFrom,
      debounceKey,
      debounceLane,
      botUsername: ctx.me?.username
    });
  };
  bot.on("callback_query", async (ctx) => {
    const callback = ctx.callbackQuery;
    if (!callback) {
      return;
    }
    if (shouldSkipUpdate(ctx)) {
      return;
    }
    const answerCallbackQuery = typeof ctx.answerCallbackQuery === "function" ? () => ctx.answerCallbackQuery() : () => bot.api.answerCallbackQuery(callback.id);
    await withTelegramApiErrorLogging({
      operation: "answerCallbackQuery",
      runtime,
      fn: answerCallbackQuery
    }).catch(() => {
    });
    try {
      const data = (callback.data ?? "").trim();
      const callbackMessage = callback.message;
      if (!data || !callbackMessage) {
        return;
      }
      const editCallbackMessage = async (text, params) => {
        const editTextFn = ctx.editMessageText;
        if (typeof editTextFn === "function") {
          return await ctx.editMessageText(text, params);
        }
        return await bot.api.editMessageText(
          callbackMessage.chat.id,
          callbackMessage.message_id,
          text,
          params
        );
      };
      const clearCallbackButtons = async () => {
        const emptyKeyboard = { inline_keyboard: [] };
        const replyMarkup = { reply_markup: emptyKeyboard };
        const editReplyMarkupFn = ctx.editMessageReplyMarkup;
        if (typeof editReplyMarkupFn === "function") {
          return await ctx.editMessageReplyMarkup(replyMarkup);
        }
        const apiEditReplyMarkupFn = bot.api.editMessageReplyMarkup;
        if (typeof apiEditReplyMarkupFn === "function") {
          return await bot.api.editMessageReplyMarkup(
            callbackMessage.chat.id,
            callbackMessage.message_id,
            replyMarkup
          );
        }
        const messageText = callbackMessage.text ?? callbackMessage.caption;
        if (typeof messageText !== "string" || messageText.trim().length === 0) {
          return void 0;
        }
        return await editCallbackMessage(messageText, replyMarkup);
      };
      const deleteCallbackMessage = async () => {
        const deleteFn = ctx.deleteMessage;
        if (typeof deleteFn === "function") {
          return await ctx.deleteMessage();
        }
        return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
      };
      const replyToCallbackChat = async (text, params) => {
        const replyFn = ctx.reply;
        if (typeof replyFn === "function") {
          return await ctx.reply(text, params);
        }
        return await bot.api.sendMessage(callbackMessage.chat.id, text, params);
      };
      const chatId = callbackMessage.chat.id;
      const isGroup = callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
      const isApprovalCallback = APPROVE_CALLBACK_DATA_RE.test(data);
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        cfg,
        accountId
      });
      const execApprovalButtonsEnabled = isApprovalCallback && shouldEnableTelegramExecApprovalButtons({
        cfg,
        accountId,
        to: String(chatId)
      });
      if (!execApprovalButtonsEnabled) {
        if (inlineButtonsScope === "off") {
          return;
        }
        if (inlineButtonsScope === "dm" && isGroup) {
          return;
        }
        if (inlineButtonsScope === "group" && !isGroup) {
          return;
        }
      }
      const messageThreadId = callbackMessage.message_thread_id;
      const isForum = callbackMessage.chat.is_forum === true;
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId,
        isGroup,
        isForum,
        messageThreadId
      });
      const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
      const requireTopic = groupConfig?.requireTopic;
      if (!isGroup && requireTopic === true && dmThreadId == null) {
        logVerbose(
          `Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`
        );
        return;
      }
      const senderId = callback.from?.id ? String(callback.from.id) : "";
      const senderUsername = callback.from?.username ?? "";
      const authorizationMode = !execApprovalButtonsEnabled && inlineButtonsScope === "allowlist" ? "callback-allowlist" : "callback-scope";
      const senderAuthorization = authorizeTelegramEventSender({
        chatId,
        chatTitle: callbackMessage.chat.title,
        isGroup,
        senderId,
        senderUsername,
        mode: authorizationMode,
        context: eventAuthContext
      });
      if (!senderAuthorization.allowed) {
        return;
      }
      if (isApprovalCallback) {
        if (!isTelegramExecApprovalClientEnabled({ cfg, accountId }) || !isTelegramExecApprovalApprover({ cfg, accountId, senderId })) {
          logVerbose(
            `Blocked telegram exec approval callback from ${senderId || "unknown"} (not an approver)`
          );
          return;
        }
        try {
          await clearCallbackButtons();
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified") && !errStr.includes("there is no text in the message to edit")) {
            logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
          }
        }
      }
      const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
      if (paginationMatch) {
        const pageValue = paginationMatch[1];
        if (pageValue === "noop") {
          return;
        }
        const page = Number.parseInt(pageValue, 10);
        if (Number.isNaN(page) || page < 1) {
          return;
        }
        const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg);
        const skillCommands = listSkillCommandsForAgents({
          cfg,
          agentIds: [agentId]
        });
        const result = buildCommandsMessagePaginated(cfg, skillCommands, {
          page,
          surface: "telegram"
        });
        const keyboard = result.totalPages > 1 ? buildInlineKeyboard(
          buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId)
        ) : void 0;
        try {
          await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : void 0);
        } catch (editErr) {
          const errStr = String(editErr);
          if (!errStr.includes("message is not modified")) {
            throw editErr;
          }
        }
        return;
      }
      const modelCallback = parseModelCallbackData(data);
      if (modelCallback) {
        const sessionState = resolveTelegramSessionState({
          chatId,
          isGroup,
          isForum,
          messageThreadId,
          resolvedThreadId,
          senderId
        });
        const modelData = await buildModelsProviderData(cfg, sessionState.agentId);
        const { byProvider, providers } = modelData;
        const editMessageWithButtons = async (text, buttons) => {
          const keyboard = buildInlineKeyboard(buttons);
          try {
            await editCallbackMessage(text, keyboard ? { reply_markup: keyboard } : void 0);
          } catch (editErr) {
            const errStr = String(editErr);
            if (errStr.includes("no text in the message")) {
              try {
                await deleteCallbackMessage();
              } catch {
              }
              await replyToCallbackChat(text, keyboard ? { reply_markup: keyboard } : void 0);
            } else if (!errStr.includes("message is not modified")) {
              throw editErr;
            }
          }
        };
        if (modelCallback.type === "providers" || modelCallback.type === "back") {
          if (providers.length === 0) {
            await editMessageWithButtons("No providers available.", []);
            return;
          }
          const providerInfos = providers.map((p) => ({
            id: p,
            count: byProvider.get(p)?.size ?? 0
          }));
          const buttons = buildProviderKeyboard(providerInfos);
          await editMessageWithButtons("Select a provider:", buttons);
          return;
        }
        if (modelCallback.type === "list") {
          const { provider, page } = modelCallback;
          const modelSet = byProvider.get(provider);
          if (!modelSet || modelSet.size === 0) {
            const providerInfos = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0
            }));
            const buttons2 = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Unknown provider: ${provider}

Select a provider:`,
              buttons2
            );
            return;
          }
          const models = [...modelSet].toSorted();
          const pageSize = getModelsPageSize();
          const totalPages = calculateTotalPages(models.length, pageSize);
          const safePage = Math.max(1, Math.min(page, totalPages));
          const currentSessionState = resolveTelegramSessionState({
            chatId,
            isGroup,
            isForum,
            messageThreadId,
            resolvedThreadId,
            senderId
          });
          const currentModel = currentSessionState.model;
          const buttons = buildModelsKeyboard({
            provider,
            models,
            currentModel,
            currentPage: safePage,
            totalPages,
            pageSize
          });
          const text = formatModelsAvailableHeader({
            provider,
            total: models.length,
            cfg,
            agentDir: resolveAgentDir(cfg, currentSessionState.agentId),
            sessionEntry: currentSessionState.sessionEntry
          });
          await editMessageWithButtons(text, buttons);
          return;
        }
        if (modelCallback.type === "select") {
          const selection = resolveModelSelection({
            callback: modelCallback,
            providers,
            byProvider
          });
          if (selection.kind !== "resolved") {
            const providerInfos = providers.map((p) => ({
              id: p,
              count: byProvider.get(p)?.size ?? 0
            }));
            const buttons = buildProviderKeyboard(providerInfos);
            await editMessageWithButtons(
              `Could not resolve model "${selection.model}".

Select a provider:`,
              buttons
            );
            return;
          }
          const modelSet = byProvider.get(selection.provider);
          if (!modelSet?.has(selection.model)) {
            await editMessageWithButtons(
              `\u274C Model "${selection.provider}/${selection.model}" is not allowed.`,
              []
            );
            return;
          }
          try {
            const storePath = resolveStorePath(cfg.session?.store, {
              agentId: sessionState.agentId
            });
            const resolvedDefault = resolveDefaultModelForAgent({
              cfg,
              agentId: sessionState.agentId
            });
            const isDefaultSelection = selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;
            await updateSessionStore(storePath, (store) => {
              const sessionKey = sessionState.sessionKey;
              const entry = store[sessionKey] ?? {};
              store[sessionKey] = entry;
              applyModelOverrideToSessionEntry({
                entry,
                selection: {
                  provider: selection.provider,
                  model: selection.model,
                  isDefault: isDefaultSelection
                }
              });
            });
            const actionText = isDefaultSelection ? "reset to default" : `changed to **${selection.provider}/${selection.model}**`;
            await editMessageWithButtons(
              `\u2705 Model ${actionText}

This model will be used for your next message.`,
              []
              // Empty buttons = remove inline keyboard
            );
          } catch (err) {
            await editMessageWithButtons(`\u274C Failed to change model: ${String(err)}`, []);
          }
          return;
        }
        return;
      }
      const syntheticMessage = buildSyntheticTextMessage({
        base: callbackMessage,
        from: callback.from,
        text: data
      });
      await processMessage(buildSyntheticContext(ctx, syntheticMessage), [], storeAllowFrom, {
        forceWasMentioned: true,
        messageIdOverride: callback.id
      });
    } catch (err) {
      runtime.error?.(danger(`callback handler failed: ${String(err)}`));
    }
  });
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    try {
      const msg = ctx.message;
      if (!msg?.migrate_to_chat_id) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
        return;
      }
      const oldChatId = String(msg.chat.id);
      const newChatId = String(msg.migrate_to_chat_id);
      const chatTitle = msg.chat.title ?? "Unknown";
      runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} \u2192 ${newChatId}`));
      if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
        runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
        return;
      }
      const currentConfig = loadConfig();
      const migration = migrateTelegramGroupConfig({
        cfg: currentConfig,
        accountId,
        oldChatId,
        newChatId
      });
      if (migration.migrated) {
        runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
        migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
        await writeConfigFile(currentConfig);
        runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
      } else if (migration.skippedExisting) {
        runtime.log?.(
          warn(
            `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`
          )
        );
      } else {
        runtime.log?.(
          warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`)
        );
      }
    } catch (err) {
      runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
    }
  });
  const handleInboundMessageLike = async (event) => {
    try {
      if (shouldSkipUpdate(event.ctxForDedupe)) {
        return;
      }
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        chatId: event.chatId,
        isGroup: event.isGroup,
        isForum: event.isForum,
        messageThreadId: event.messageThreadId
      });
      const {
        dmPolicy,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        groupAllowOverride,
        effectiveGroupAllow,
        hasGroupAllowOverride
      } = eventAuthContext;
      const dmAllowFrom = groupAllowOverride ?? allowFrom;
      const effectiveDmAllow = normalizeDmAllowFromWithStore({
        allowFrom: dmAllowFrom,
        storeAllowFrom,
        dmPolicy
      });
      if (event.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
        logVerbose(`Blocked telegram channel ${event.chatId} (channel disabled)`);
        return;
      }
      if (shouldSkipGroupMessage({
        isGroup: event.isGroup,
        chatId: event.chatId,
        chatTitle: event.msg.chat.title,
        resolvedThreadId,
        senderId: event.senderId,
        senderUsername: event.senderUsername,
        effectiveGroupAllow,
        hasGroupAllowOverride,
        groupConfig,
        topicConfig
      })) {
        return;
      }
      if (!event.isGroup && (hasInboundMedia(event.msg) || hasReplyTargetMedia(event.msg))) {
        const dmAuthorized = await enforceTelegramDmAccess({
          isGroup: event.isGroup,
          dmPolicy,
          msg: event.msg,
          chatId: event.chatId,
          effectiveDmAllow,
          accountId,
          bot,
          logger
        });
        if (!dmAuthorized) {
          return;
        }
      }
      await processInboundMessage({
        ctx: event.ctx,
        msg: event.msg,
        chatId: event.chatId,
        resolvedThreadId,
        dmThreadId,
        storeAllowFrom,
        sendOversizeWarning: event.sendOversizeWarning,
        oversizeLogMessage: event.oversizeLogMessage
      });
    } catch (err) {
      runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
    }
  };
  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    if (!msg) {
      return;
    }
    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, msg),
      msg,
      chatId: msg.chat.id,
      isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
      isForum: msg.chat.is_forum === true,
      messageThreadId: msg.message_thread_id,
      senderId: msg.from?.id != null ? String(msg.from.id) : "",
      senderUsername: msg.from?.username ?? "",
      requireConfiguredGroup: false,
      sendOversizeWarning: true,
      oversizeLogMessage: "media exceeds size limit",
      errorMessage: "handler failed"
    });
  });
  bot.on("channel_post", async (ctx) => {
    const post = ctx.channelPost;
    if (!post) {
      return;
    }
    const chatId = post.chat.id;
    const syntheticFrom = post.sender_chat ? {
      id: post.sender_chat.id,
      is_bot: true,
      first_name: post.sender_chat.title || "Channel",
      username: post.sender_chat.username
    } : {
      id: chatId,
      is_bot: true,
      first_name: post.chat.title || "Channel",
      username: post.chat.username
    };
    const syntheticMsg = {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup"
      }
    };
    await handleInboundMessageLike({
      ctxForDedupe: ctx,
      ctx: buildSyntheticContext(ctx, syntheticMsg),
      msg: syntheticMsg,
      chatId,
      isGroup: true,
      isForum: false,
      senderId: post.sender_chat?.id != null ? String(post.sender_chat.id) : post.from?.id != null ? String(post.from.id) : "",
      senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
      requireConfiguredGroup: true,
      sendOversizeWarning: false,
      oversizeLogMessage: "channel post media exceeds size limit",
      errorMessage: "channel_post handler failed"
    });
  });
};
export {
  registerTelegramHandlers
};
