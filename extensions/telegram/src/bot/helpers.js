import { formatLocationText } from "../../../../src/channels/location.js";
import { resolveTelegramPreviewStreamMode } from "../../../../src/config/discord-preview-streaming.js";
import { readChannelAllowFromStore } from "../../../../src/pairing/pairing-store.js";
import { normalizeAccountId } from "../../../../src/routing/session-key.js";
import { firstDefined, normalizeAllowFrom } from "../bot-access.js";
const TELEGRAM_GENERAL_TOPIC_ID = 1;
async function resolveTelegramGroupAllowFromContext(params) {
  const accountId = normalizeAccountId(params.accountId);
  const threadSpec = resolveTelegramThreadSpec({
    isGroup: params.isGroup ?? false,
    isForum: params.isForum,
    messageThreadId: params.messageThreadId
  });
  const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : void 0;
  const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : void 0;
  const threadIdForConfig = resolvedThreadId ?? dmThreadId;
  const storeAllowFrom = await readChannelAllowFromStore("telegram", process.env, accountId).catch(
    () => []
  );
  const { groupConfig, topicConfig } = params.resolveTelegramGroupConfig(
    params.chatId,
    threadIdForConfig
  );
  const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
  const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? params.groupAllowFrom);
  const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
  return {
    resolvedThreadId,
    dmThreadId,
    storeAllowFrom,
    groupConfig,
    topicConfig,
    groupAllowOverride,
    effectiveGroupAllow,
    hasGroupAllowOverride
  };
}
function resolveTelegramForumThreadId(params) {
  if (!params.isForum) {
    return void 0;
  }
  if (params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId;
}
function resolveTelegramThreadSpec(params) {
  if (params.isGroup) {
    const id = resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId
    });
    return {
      id,
      scope: params.isForum ? "forum" : "none"
    };
  }
  if (params.messageThreadId == null) {
    return { scope: "dm" };
  }
  return {
    id: params.messageThreadId,
    scope: "dm"
  };
}
function buildTelegramThreadParams(thread) {
  if (thread?.id == null) {
    return void 0;
  }
  const normalized = Math.trunc(thread.id);
  if (thread.scope === "dm") {
    return normalized > 0 ? { message_thread_id: normalized } : void 0;
  }
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) {
    return void 0;
  }
  return { message_thread_id: normalized };
}
function buildTypingThreadParams(messageThreadId) {
  if (messageThreadId == null) {
    return void 0;
  }
  return { message_thread_id: Math.trunc(messageThreadId) };
}
function resolveTelegramStreamMode(telegramCfg) {
  return resolveTelegramPreviewStreamMode(telegramCfg);
}
function buildTelegramGroupPeerId(chatId, messageThreadId) {
  return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}
function resolveTelegramDirectPeerId(params) {
  const senderId = params.senderId != null ? String(params.senderId).trim() : "";
  if (senderId) {
    return senderId;
  }
  return String(params.chatId);
}
function buildTelegramGroupFrom(chatId, messageThreadId) {
  return `telegram:group:${buildTelegramGroupPeerId(chatId, messageThreadId)}`;
}
function buildTelegramParentPeer(params) {
  if (!params.isGroup || params.resolvedThreadId == null) {
    return void 0;
  }
  return { kind: "group", id: String(params.chatId) };
}
function buildSenderName(msg) {
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || msg.from?.username;
  return name || void 0;
}
function resolveTelegramMediaPlaceholder(msg) {
  if (!msg) {
    return void 0;
  }
  if (msg.photo) {
    return "<media:image>";
  }
  if (msg.video || msg.video_note) {
    return "<media:video>";
  }
  if (msg.audio || msg.voice) {
    return "<media:audio>";
  }
  if (msg.document) {
    return "<media:document>";
  }
  if (msg.sticker) {
    return "<media:sticker>";
  }
  return void 0;
}
function buildSenderLabel(msg, senderId) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : void 0;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId = senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : void 0;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : void 0);
  const idPart = fallbackId ? `id:${fallbackId}` : void 0;
  if (label && idPart) {
    return `${label} ${idPart}`;
  }
  if (label) {
    return label;
  }
  return idPart ?? "id:unknown";
}
function buildGroupLabel(msg, chatId, messageThreadId) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) {
    return `${title} id:${chatId}${topicSuffix}`;
  }
  return `group:${chatId}${topicSuffix}`;
}
function getTelegramTextParts(msg) {
  const text = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  return { text, entities };
}
function isTelegramMentionWordChar(char) {
  return char != null && /[a-z0-9_]/i.test(char);
}
function hasStandaloneTelegramMention(text, mention) {
  let startIndex = 0;
  while (startIndex < text.length) {
    const idx = text.indexOf(mention, startIndex);
    if (idx === -1) {
      return false;
    }
    const prev = idx > 0 ? text[idx - 1] : void 0;
    const next = text[idx + mention.length];
    if (!isTelegramMentionWordChar(prev) && !isTelegramMentionWordChar(next)) {
      return true;
    }
    startIndex = idx + 1;
  }
  return false;
}
function hasBotMention(msg, botUsername) {
  const { text, entities } = getTelegramTextParts(msg);
  const mention = `@${botUsername}`.toLowerCase();
  if (hasStandaloneTelegramMention(text.toLowerCase(), mention)) {
    return true;
  }
  for (const ent of entities) {
    if (ent.type !== "mention") {
      continue;
    }
    const slice = text.slice(ent.offset, ent.offset + ent.length);
    if (slice.toLowerCase() === mention) {
      return true;
    }
  }
  return false;
}
function expandTextLinks(text, entities) {
  if (!text || !entities?.length) {
    return text;
  }
  const textLinks = entities.filter(
    (entity) => entity.type === "text_link" && Boolean(entity.url)
  ).toSorted((a, b) => b.offset - a.offset);
  if (textLinks.length === 0) {
    return text;
  }
  let result = text;
  for (const entity of textLinks) {
    const linkText = text.slice(entity.offset, entity.offset + entity.length);
    const markdown = `[${linkText}](${entity.url})`;
    result = result.slice(0, entity.offset) + markdown + result.slice(entity.offset + entity.length);
  }
  return result;
}
function resolveTelegramReplyId(raw) {
  if (!raw) {
    return void 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return void 0;
  }
  return parsed;
}
function describeReplyTarget(msg) {
  const reply = msg.reply_to_message;
  const externalReply = msg.external_reply;
  const quoteText = msg.quote?.text ?? externalReply?.quote?.text;
  let body = "";
  let kind = "reply";
  if (typeof quoteText === "string") {
    body = quoteText.trim();
    if (body) {
      kind = "quote";
    }
  }
  const replyLike = reply ?? externalReply;
  if (!body && replyLike) {
    const replyBody = (replyLike.text ?? replyLike.caption ?? "").trim();
    body = replyBody;
    if (!body) {
      body = resolveTelegramMediaPlaceholder(replyLike) ?? "";
      if (!body) {
        const locationData = extractTelegramLocation(replyLike);
        if (locationData) {
          body = formatLocationText(locationData);
        }
      }
    }
  }
  if (!body) {
    return null;
  }
  const sender = replyLike ? buildSenderName(replyLike) : void 0;
  const senderLabel = sender ?? "unknown sender";
  const forwardedFrom = replyLike?.forward_origin ? resolveForwardOrigin(replyLike.forward_origin) ?? void 0 : void 0;
  return {
    id: replyLike?.message_id ? String(replyLike.message_id) : void 0,
    sender: senderLabel,
    body,
    kind,
    forwardedFrom
  };
}
function normalizeForwardedUserLabel(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = user.username?.trim() || void 0;
  const id = String(user.id);
  const display = (name && username ? `${name} (@${username})` : name || (username ? `@${username}` : void 0)) || `user:${id}`;
  return { display, name: name || void 0, username, id };
}
function normalizeForwardedChatLabel(chat, fallbackKind) {
  const title = chat.title?.trim() || void 0;
  const username = chat.username?.trim() || void 0;
  const id = String(chat.id);
  const display = title || (username ? `@${username}` : void 0) || `${fallbackKind}:${id}`;
  return { display, title, username, id };
}
function buildForwardedContextFromUser(params) {
  const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
  if (!display) {
    return null;
  }
  return {
    from: display,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: name
  };
}
function buildForwardedContextFromHiddenName(params) {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return null;
  }
  return {
    from: trimmed,
    date: params.date,
    fromType: params.type,
    fromTitle: trimmed
  };
}
function buildForwardedContextFromChat(params) {
  const fallbackKind = params.type === "channel" ? "channel" : "chat";
  const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
  if (!display) {
    return null;
  }
  const signature = params.signature?.trim() || void 0;
  const from = signature ? `${display} (${signature})` : display;
  const chatType = params.chat.type?.trim() || void 0;
  return {
    from,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: title,
    fromSignature: signature,
    fromChatType: chatType,
    fromMessageId: params.messageId
  };
}
function resolveForwardOrigin(origin) {
  switch (origin.type) {
    case "user":
      return buildForwardedContextFromUser({
        user: origin.sender_user,
        date: origin.date,
        type: "user"
      });
    case "hidden_user":
      return buildForwardedContextFromHiddenName({
        name: origin.sender_user_name,
        date: origin.date,
        type: "hidden_user"
      });
    case "chat":
      return buildForwardedContextFromChat({
        chat: origin.sender_chat,
        date: origin.date,
        type: "chat",
        signature: origin.author_signature
      });
    case "channel":
      return buildForwardedContextFromChat({
        chat: origin.chat,
        date: origin.date,
        type: "channel",
        signature: origin.author_signature,
        messageId: origin.message_id
      });
    default:
      origin;
      return null;
  }
}
function normalizeForwardedContext(msg) {
  if (!msg.forward_origin) {
    return null;
  }
  return resolveForwardOrigin(msg.forward_origin);
}
function extractTelegramLocation(msg) {
  const { venue, location } = msg;
  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false
    };
  }
  if (location) {
    const isLive = typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive
    };
  }
  return null;
}
export {
  buildGroupLabel,
  buildSenderLabel,
  buildSenderName,
  buildTelegramGroupFrom,
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  describeReplyTarget,
  expandTextLinks,
  extractTelegramLocation,
  getTelegramTextParts,
  hasBotMention,
  normalizeForwardedContext,
  resolveTelegramDirectPeerId,
  resolveTelegramForumThreadId,
  resolveTelegramGroupAllowFromContext,
  resolveTelegramMediaPlaceholder,
  resolveTelegramReplyId,
  resolveTelegramStreamMode,
  resolveTelegramThreadSpec
};
