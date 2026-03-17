import {
  buildAgentMediaPayload,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createScopedPairingAccess,
  DEFAULT_GROUP_HISTORY_LIMIT,
  issuePairingChallenge,
  normalizeAgentId,
  recordPendingHistoryEntryIfEnabled,
  resolveAgentOutboundIdentity,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { finalizeFeishuMessageProcessing, tryRecordMessagePersistent } from "./dedup.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { downloadMessageResourceFeishu } from "./media.js";
import { extractMentionTargets, isMentionForwardRequest } from "./mention.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed
} from "./policy.js";
import { parsePostContent } from "./post.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, listFeishuThreadMessages, sendMessageFeishu } from "./send.js";
const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];
const FEISHU_SCOPE_CORRECTIONS = {
  "contact:contact.base:readonly": "contact:user.base:readonly"
};
function correctFeishuScopeInUrl(url) {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}
function shouldSuppressPermissionErrorNotice(permissionError) {
  const message = permissionError.message.toLowerCase();
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}
function extractPermissionError(err) {
  if (!err || typeof err !== "object") return null;
  const axiosErr = err;
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;
  const feishuErr = data;
  if (feishuErr.code !== 99991672) return null;
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : void 0;
  return {
    code: feishuErr.code,
    message: msg,
    grantUrl
  };
}
const SENDER_NAME_TTL_MS = 10 * 60 * 1e3;
const senderNameCache = /* @__PURE__ */ new Map();
const permissionErrorNotifiedAt = /* @__PURE__ */ new Map();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1e3;
function resolveSenderLookupIdType(senderId) {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}
async function resolveFeishuSenderName(params) {
  const { account, senderId, log } = params;
  if (!account.configured) return {};
  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) return {};
  const cached = senderNameCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };
  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);
    const res = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType }
    });
    const name = res?.data?.user?.name || res?.data?.user?.display_name || res?.data?.user?.nickname || res?.data?.user?.en_name;
    if (name && typeof name === "string") {
      senderNameCache.set(normalizedSenderId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }
    return {};
  } catch (err) {
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}
function resolveFeishuGroupSession(params) {
  const { chatId, senderOpenId, messageId, rootId, threadId, groupConfig, feishuCfg } = params;
  const normalizedThreadId = threadId?.trim();
  const normalizedRootId = rootId?.trim();
  const threadReply = Boolean(normalizedThreadId || normalizedRootId);
  const replyInThread = (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" || threadReply;
  const legacyTopicSessionMode = groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
  const groupSessionScope = groupConfig?.groupSessionScope ?? feishuCfg?.groupSessionScope ?? (legacyTopicSessionMode === "enabled" ? "group_topic" : "group");
  const topicScope = groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender" ? normalizedRootId ?? normalizedThreadId ?? (replyInThread ? messageId : null) : null;
  let peerId = chatId;
  switch (groupSessionScope) {
    case "group_sender":
      peerId = `${chatId}:sender:${senderOpenId}`;
      break;
    case "group_topic":
      peerId = topicScope ? `${chatId}:topic:${topicScope}` : chatId;
      break;
    case "group_topic_sender":
      peerId = topicScope ? `${chatId}:topic:${topicScope}:sender:${senderOpenId}` : `${chatId}:sender:${senderOpenId}`;
      break;
    case "group":
    default:
      peerId = chatId;
      break;
  }
  const parentPeer = topicScope && (groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender") ? {
    kind: "group",
    id: chatId
  } : null;
  return {
    peerId,
    parentPeer,
    groupSessionScope,
    replyInThread,
    threadReply
  };
}
function parseMessageContent(content, messageType) {
  if (messageType === "post") {
    const { textContent } = parsePostContent(content);
    return textContent;
  }
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "share_chat") {
      if (parsed && typeof parsed === "object") {
        const share = parsed;
        if (typeof share.body === "string" && share.body.trim().length > 0) {
          return share.body.trim();
        }
        if (typeof share.summary === "string" && share.summary.trim().length > 0) {
          return share.summary.trim();
        }
        if (typeof share.share_chat_id === "string" && share.share_chat_id.trim().length > 0) {
          return `[Forwarded message: ${share.share_chat_id.trim()}]`;
        }
      }
      return "[Forwarded message]";
    }
    if (messageType === "merge_forward") {
      return "[Merged and Forwarded Message - loading...]";
    }
    return content;
  } catch {
    return content;
  }
}
function parseMergeForwardContent(params) {
  const { content, log } = params;
  const maxMessages = 50;
  log?.(`feishu: parsing merge_forward sub-messages from API response`);
  let items;
  try {
    items = JSON.parse(content);
  } catch {
    log?.(`feishu: merge_forward items parse failed`);
    return "[Merged and Forwarded Message - parse error]";
  }
  if (!Array.isArray(items) || items.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages]";
  }
  const subMessages = items.filter((item) => item.upper_message_id);
  if (subMessages.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages found]";
  }
  log?.(`feishu: merge_forward contains ${subMessages.length} sub-messages`);
  subMessages.sort((a, b) => {
    const timeA = parseInt(a.create_time || "0", 10);
    const timeB = parseInt(b.create_time || "0", 10);
    return timeA - timeB;
  });
  const lines = ["[Merged and Forwarded Messages]"];
  const limitedMessages = subMessages.slice(0, maxMessages);
  for (const item of limitedMessages) {
    const msgContent = item.body?.content || "";
    const msgType = item.msg_type || "text";
    const formatted = formatSubMessageContent(msgContent, msgType);
    lines.push(`- ${formatted}`);
  }
  if (subMessages.length > maxMessages) {
    lines.push(`... and ${subMessages.length - maxMessages} more messages`);
  }
  return lines.join("\n");
}
function formatSubMessageContent(content, contentType) {
  try {
    const parsed = JSON.parse(content);
    switch (contentType) {
      case "text":
        return parsed.text || content;
      case "post": {
        const { textContent } = parsePostContent(content);
        return textContent;
      }
      case "image":
        return "[Image]";
      case "file":
        return `[File: ${parsed.file_name || "unknown"}]`;
      case "audio":
        return "[Audio]";
      case "video":
        return "[Video]";
      case "sticker":
        return "[Sticker]";
      case "merge_forward":
        return "[Nested Merged Forward]";
      default:
        return `[${contentType}]`;
    }
  } catch {
    return content;
  }
}
function checkBotMentioned(event, botOpenId) {
  if (!botOpenId) return false;
  const rawContent = event.message.content ?? "";
  if (rawContent.includes("@_all")) return true;
  const mentions = event.message.mentions ?? [];
  if (mentions.length > 0) {
    return mentions.some((m) => m.id.open_id === botOpenId);
  }
  if (event.message.message_type === "post") {
    const { mentionedOpenIds } = parsePostContent(event.message.content);
    return mentionedOpenIds.some((id) => id === botOpenId);
  }
  return false;
}
function normalizeMentions(text, mentions, botStripId) {
  if (!mentions || mentions.length === 0) return text;
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeName = (value) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let result = text;
  for (const mention of mentions) {
    const mentionId = mention.id.open_id;
    const replacement = botStripId && mentionId === botStripId ? "" : mentionId ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>` : `@${mention.name}`;
    result = result.replace(new RegExp(escaped(mention.key), "g"), () => replacement).trim();
  }
  return result;
}
function normalizeFeishuCommandProbeBody(text) {
  if (!text) {
    return "";
  }
  return text.replace(/<at\b[^>]*>[^<]*<\/at>/giu, " ").replace(/(^|\s)@[^/\s]+(?=\s|$|\/)/gu, "$1").replace(/\s+/g, " ").trim();
}
function parseMediaKeys(content, messageType) {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey };
      case "file":
        return { fileKey, fileName: parsed.file_name };
      case "audio":
        return { fileKey };
      case "video":
      case "media":
        return { fileKey, imageKey };
      case "sticker":
        return { fileKey };
      default:
        return {};
    }
  } catch {
    return {};
  }
}
function toMessageResourceType(messageType) {
  return messageType === "image" ? "image" : "file";
}
function inferPlaceholder(messageType) {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
    case "media":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}
async function resolveFeishuMediaList(params) {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;
  const mediaTypes = ["image", "file", "audio", "video", "media", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }
  const out = [];
  const core = getFeishuRuntime();
  if (messageType === "post") {
    const { imageKeys, mediaKeys: postMediaKeys } = parsePostContent(content);
    if (imageKeys.length === 0 && postMediaKeys.length === 0) {
      return [];
    }
    if (imageKeys.length > 0) {
      log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);
    }
    if (postMediaKeys.length > 0) {
      log?.(`feishu: post message contains ${postMediaKeys.length} embedded media file(s)`);
    }
    for (const imageKey of imageKeys) {
      try {
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
          accountId
        });
        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }
        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes
        );
        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>"
        });
        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }
    for (const media of postMediaKeys) {
      try {
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: media.fileKey,
          type: "file",
          accountId
        });
        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }
        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes
        );
        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:video>"
        });
        log?.(`feishu: downloaded embedded media ${media.fileKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded media ${media.fileKey}: ${String(err)}`);
      }
    }
    return out;
  }
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }
  try {
    let buffer;
    let contentType;
    let fileName;
    const fileKey = mediaKeys.fileKey || mediaKeys.imageKey;
    if (!fileKey) {
      return [];
    }
    const resourceType = toMessageResourceType(messageType);
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
      accountId
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName
    );
    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType)
    });
    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }
  return out;
}
function resolveBroadcastAgents(cfg, peerId) {
  const broadcast = cfg.broadcast;
  if (!broadcast || typeof broadcast !== "object") return null;
  const agents = broadcast[peerId];
  if (!Array.isArray(agents) || agents.length === 0) return null;
  return agents;
}
function buildBroadcastSessionKey(baseSessionKey, originalAgentId, targetAgentId) {
  const prefix = `agent:${originalAgentId}:`;
  if (baseSessionKey.startsWith(prefix)) {
    return `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`;
  }
  return baseSessionKey;
}
function parseFeishuMessageEvent(event, botOpenId, _botName) {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  const content = normalizeMentions(rawContent, event.message.mentions, botOpenId);
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";
  const ctx = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: event.message.root_id || void 0,
    parentId: event.message.parent_id || void 0,
    threadId: event.message.thread_id || void 0,
    content,
    contentType: event.message.message_type
  };
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }
  return ctx;
}
function buildFeishuAgentBody(params) {
  const { ctx, quotedContent, permissionErrorForAgent, botOpenId } = params;
  let messageBody = ctx.content;
  if (quotedContent) {
    messageBody = `[Replying to: "${quotedContent}"]

${ctx.content}`;
  }
  const speaker = ctx.senderName ?? ctx.senderOpenId;
  messageBody = `${speaker}: ${messageBody}`;
  if (ctx.hasAnyMention) {
    const botIdHint = botOpenId?.trim();
    messageBody += `

[System: The content may include mention tags in the form <at user_id="...">name</at>. Treat these as real mentions of Feishu entities (users or bots).]`;
    if (botIdHint) {
      messageBody += `
[System: If user_id is "${botIdHint}", that mention refers to you.]`;
    }
  }
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
    messageBody += `

[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
  }
  messageBody = `[message_id: ${ctx.messageId}]
${messageBody}`;
  if (permissionErrorForAgent) {
    const grantUrl = permissionErrorForAgent.grantUrl ?? "";
    messageBody += `

[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
  }
  return messageBody;
}
async function handleFeishuMessage(params) {
  const {
    cfg,
    event,
    botOpenId,
    botName,
    runtime,
    chatHistories,
    accountId,
    processingClaimHeld = false
  } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const messageId = event.message.message_id;
  if (!await finalizeFeishuMessageProcessing({
    messageId,
    namespace: account.accountId,
    log,
    claimHeld: processingClaimHeld
  })) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }
  let ctx = parseFeishuMessageEvent(event, botOpenId, botName);
  const isGroup = ctx.chatType === "group";
  const isDirect = !isGroup;
  const senderUserId = event.sender.sender_id.user_id?.trim() || void 0;
  if (event.message.message_type === "merge_forward") {
    log(
      `feishu[${account.accountId}]: processing merge_forward message, fetching full content via API`
    );
    try {
      const client = createFeishuClient(account);
      const response = await client.im.message.get({
        path: { message_id: event.message.message_id }
      });
      if (response.code === 0 && response.data?.items && response.data.items.length > 0) {
        log(
          `feishu[${account.accountId}]: merge_forward API returned ${response.data.items.length} items`
        );
        const expandedContent = parseMergeForwardContent({
          content: JSON.stringify(response.data.items),
          log
        });
        ctx = { ...ctx, content: expandedContent };
      } else {
        log(`feishu[${account.accountId}]: merge_forward API returned no items`);
        ctx = { ...ctx, content: "[Merged and Forwarded Message - could not fetch]" };
      }
    } catch (err) {
      log(`feishu[${account.accountId}]: merge_forward fetch failed: ${String(err)}`);
      ctx = { ...ctx, content: "[Merged and Forwarded Message - fetch error]" };
    }
  }
  let permissionErrorForAgent;
  if (feishuCfg?.resolveSenderNames ?? true) {
    const senderResult = await resolveFeishuSenderName({
      account,
      senderId: ctx.senderOpenId,
      log
    });
    if (senderResult.name) ctx = { ...ctx, senderName: senderResult.name };
    if (senderResult.permissionError) {
      const appKey = account.appId ?? "default";
      const now = Date.now();
      const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;
      if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
        permissionErrorNotifiedAt.set(appKey, now);
        permissionErrorForAgent = senderResult.permissionError;
      }
    }
  }
  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`
  );
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }
  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT
  );
  const groupConfig = isGroup ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId }) : void 0;
  const groupSession = isGroup ? resolveFeishuGroupSession({
    chatId: ctx.chatId,
    senderOpenId: ctx.senderOpenId,
    messageId: ctx.messageId,
    rootId: ctx.rootId,
    threadId: ctx.threadId,
    groupConfig,
    feishuCfg
  }) : null;
  const groupHistoryKey = isGroup ? groupSession?.peerId ?? ctx.chatId : void 0;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
  const broadcastAgents = rawBroadcastAgents ? [...new Set(rawBroadcastAgents.map((id) => normalizeAgentId(id)))] : null;
  let requireMention = false;
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} is disabled`);
      return;
    }
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== void 0,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log
    });
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId,
      // Check group ID, not sender ID
      senderName: void 0
    });
    if (!groupAllowed) {
      log(
        `feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`
      );
      return;
    }
    const perGroupSenderAllowFrom = groupConfig?.allowFrom ?? [];
    const globalSenderAllowFrom = feishuCfg?.groupSenderAllowFrom ?? [];
    const effectiveSenderAllowFrom = perGroupSenderAllowFrom.length > 0 ? perGroupSenderAllowFrom : globalSenderAllowFrom;
    if (effectiveSenderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: effectiveSenderAllowFrom,
        senderId: ctx.senderOpenId,
        senderIds: [senderUserId],
        senderName: ctx.senderName
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        return;
      }
    }
    ({ requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig
    }));
    if (requireMention && !ctx.mentionedBot) {
      log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
      if (!broadcastAgents && chatHistories && groupHistoryKey) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: groupHistoryKey,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId
          }
        });
      }
      return;
    }
  } else {
  }
  try {
    const core = getFeishuRuntime();
    const pairing = createScopedPairingAccess({
      core,
      channel: "feishu",
      accountId: account.accountId
    });
    const commandProbeBody = isGroup ? normalizeFeishuCommandProbeBody(ctx.content) : ctx.content;
    const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
      commandProbeBody,
      cfg
    );
    const storeAllowFrom = !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeCommandAuthorized) ? await pairing.readAllowFromStore().catch(() => []) : [];
    const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const dmAllowed = resolveFeishuAllowlistMatch({
      allowFrom: effectiveDmAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName
    }).allowed;
    if (isDirect && dmPolicy !== "open" && !dmAllowed) {
      if (dmPolicy === "pairing") {
        await issuePairingChallenge({
          channel: "feishu",
          senderId: ctx.senderOpenId,
          senderIdLine: `Your Feishu user id: ${ctx.senderOpenId}`,
          meta: { name: ctx.senderName },
          upsertPairingRequest: pairing.upsertPairingRequest,
          onCreated: () => {
            log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          },
          sendPairingReply: async (text) => {
            await sendMessageFeishu({
              cfg,
              to: `chat:${ctx.chatId}`,
              text,
              accountId: account.accountId
            });
          },
          onReplyError: (err) => {
            log(
              `feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`
            );
          }
        });
      } else {
        log(
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} (dmPolicy=${dmPolicy})`
        );
      }
      return;
    }
    const commandAllowFrom = isGroup ? groupConfig?.allowFrom ?? configAllowFrom : effectiveDmAllowFrom;
    const senderAllowedForCommands = resolveFeishuAllowlistMatch({
      allowFrom: commandAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName
    }).allowed;
    const commandAuthorized = shouldComputeCommandAuthorized ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers: [
        { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands }
      ]
    }) : void 0;
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
    const peerId = isGroup ? groupSession?.peerId ?? ctx.chatId : ctx.senderOpenId;
    const parentPeer = isGroup ? groupSession?.parentPeer ?? null : null;
    const replyInThread = isGroup ? groupSession?.replyInThread ?? false : false;
    if (isGroup && groupSession) {
      log(
        `feishu[${account.accountId}]: group session scope=${groupSession.groupSessionScope}, peer=${peerId}`
      );
    }
    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId
      },
      parentPeer
    });
    let effectiveCfg = cfg;
    if (!isGroup && route.matchedBy === "default") {
      const dynamicCfg = feishuCfg?.dynamicAgentCreation;
      if (dynamicCfg?.enabled) {
        const runtime2 = getFeishuRuntime();
        const result = await maybeCreateDynamicAgent({
          cfg,
          runtime: runtime2,
          senderOpenId: ctx.senderOpenId,
          dynamicCfg,
          log: (msg) => log(msg)
        });
        if (result.created) {
          effectiveCfg = result.updatedCfg;
          route = core.channel.routing.resolveAgentRoute({
            cfg: result.updatedCfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: { kind: "direct", id: ctx.senderOpenId }
          });
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`
          );
        }
      }
    }
    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup ? `Feishu[${account.accountId}] message in group ${ctx.chatId}` : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;
    log(`feishu[${account.accountId}]: ${inboundLabel}: ${preview}`);
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024;
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId
    });
    const mediaPayload = buildAgentMediaPayload(mediaList);
    let quotedMessageInfo = null;
    let quotedContent;
    if (ctx.parentId) {
      try {
        quotedMessageInfo = await getMessageFeishu({
          cfg,
          messageId: ctx.parentId,
          accountId: account.accountId
        });
        if (quotedMessageInfo) {
          quotedContent = quotedMessageInfo.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`
          );
        }
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
      }
    }
    const isTopicSessionForThread = isGroup && (groupSession?.groupSessionScope === "group_topic" || groupSession?.groupSessionScope === "group_topic_sender");
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const messageBody = buildFeishuAgentBody({
      ctx,
      quotedContent,
      permissionErrorForAgent,
      botOpenId
    });
    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;
    if (permissionErrorForAgent) {
      log(`feishu[${account.accountId}]: appending permission error notice to message body`);
    }
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: /* @__PURE__ */ new Date(),
      envelope: envelopeOptions,
      body: messageBody
    });
    let combinedBody = body;
    const historyKey = groupHistoryKey;
    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
          channel: "Feishu",
          // Preserve speaker identity in group history as well.
          from: `${ctx.chatId}:${entry.sender}`,
          timestamp: entry.timestamp,
          body: entry.body,
          envelope: envelopeOptions
        })
      });
    }
    const inboundHistory = isGroup && historyKey && historyLimit > 0 && chatHistories ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
      sender: entry.sender,
      body: entry.body,
      timestamp: entry.timestamp
    })) : void 0;
    const threadContextBySessionKey = /* @__PURE__ */ new Map();
    let rootMessageInfo;
    let rootMessageFetched = false;
    const getRootMessageInfo = async () => {
      if (!ctx.rootId) {
        return null;
      }
      if (!rootMessageFetched) {
        rootMessageFetched = true;
        if (ctx.rootId === ctx.parentId && quotedMessageInfo) {
          rootMessageInfo = quotedMessageInfo;
        } else {
          try {
            rootMessageInfo = await getMessageFeishu({
              cfg,
              messageId: ctx.rootId,
              accountId: account.accountId
            });
          } catch (err) {
            log(`feishu[${account.accountId}]: failed to fetch root message: ${String(err)}`);
            rootMessageInfo = null;
          }
        }
      }
      return rootMessageInfo ?? null;
    };
    const resolveThreadContextForAgent = async (agentId, agentSessionKey) => {
      const cached = threadContextBySessionKey.get(agentSessionKey);
      if (cached) {
        return cached;
      }
      const threadContext = {
        threadLabel: (ctx.rootId || ctx.threadId) && isTopicSessionForThread ? `Feishu thread in ${ctx.chatId}` : void 0
      };
      if (!(ctx.rootId || ctx.threadId) || !isTopicSessionForThread) {
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }
      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId });
      const previousThreadSessionTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: agentSessionKey
      });
      if (previousThreadSessionTimestamp) {
        log(
          `feishu[${account.accountId}]: skipping thread bootstrap for existing session ${agentSessionKey}`
        );
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }
      const rootMsg = await getRootMessageInfo();
      let feishuThreadId = ctx.threadId ?? rootMsg?.threadId;
      if (feishuThreadId) {
        log(`feishu[${account.accountId}]: resolved thread ID: ${feishuThreadId}`);
      }
      if (!feishuThreadId) {
        log(
          `feishu[${account.accountId}]: no threadId found for root message ${ctx.rootId ?? "none"}, skipping thread history`
        );
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }
      try {
        const threadMessages = await listFeishuThreadMessages({
          cfg,
          threadId: feishuThreadId,
          currentMessageId: ctx.messageId,
          rootMessageId: ctx.rootId,
          limit: 20,
          accountId: account.accountId
        });
        const senderScoped = groupSession?.groupSessionScope === "group_topic_sender";
        const senderIds = new Set(
          [ctx.senderOpenId, senderUserId].map((id) => id?.trim()).filter((id) => id !== void 0 && id.length > 0)
        );
        const relevantMessages = (senderScoped ? threadMessages.filter(
          (msg) => msg.senderType === "app" || msg.senderId !== void 0 && senderIds.has(msg.senderId.trim())
        ) : threadMessages) ?? [];
        const threadStarterBody = rootMsg?.content ?? relevantMessages[0]?.content;
        const includeStarterInHistory = Boolean(rootMsg?.content || ctx.rootId);
        const historyMessages = includeStarterInHistory ? relevantMessages : relevantMessages.slice(1);
        const historyParts = historyMessages.map((msg) => {
          const role = msg.senderType === "app" ? "assistant" : "user";
          return core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            from: `${msg.senderId ?? "Unknown"} (${role})`,
            timestamp: msg.createTime,
            body: msg.content,
            envelope: envelopeOptions
          });
        });
        threadContext.threadStarterBody = threadStarterBody;
        threadContext.threadHistoryBody = historyParts.length > 0 ? historyParts.join("\n\n") : void 0;
        log(
          `feishu[${account.accountId}]: populated thread bootstrap with starter=${threadStarterBody ? "yes" : "no"} history=${historyMessages.length}`
        );
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch thread history: ${String(err)}`);
      }
      threadContextBySessionKey.set(agentSessionKey, threadContext);
      return threadContext;
    };
    const buildCtxPayloadForAgent = async (agentId, agentSessionKey, agentAccountId, wasMentioned) => {
      const threadContext = await resolveThreadContextForAgent(agentId, agentSessionKey);
      return core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: messageBody,
        InboundHistory: inboundHistory,
        ReplyToId: ctx.parentId,
        RootMessageId: ctx.rootId,
        RawBody: ctx.content,
        CommandBody: ctx.content,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: agentSessionKey,
        AccountId: agentAccountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : void 0,
        SenderName: ctx.senderName ?? ctx.senderOpenId,
        SenderId: ctx.senderOpenId,
        Provider: "feishu",
        Surface: "feishu",
        MessageSid: ctx.messageId,
        ReplyToBody: quotedContent ?? void 0,
        ThreadStarterBody: threadContext.threadStarterBody,
        ThreadHistoryBody: threadContext.threadHistoryBody,
        ThreadLabel: threadContext.threadLabel,
        // Only use rootId (om_* message anchor) — threadId (omt_*) is a container
        // ID and would produce invalid reply targets downstream.
        MessageThreadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : void 0,
        Timestamp: Date.now(),
        WasMentioned: wasMentioned,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "feishu",
        OriginatingTo: feishuTo,
        GroupSystemPrompt: isGroup ? groupConfig?.systemPrompt?.trim() || void 0 : void 0,
        ...mediaPayload
      });
    };
    const messageCreateTimeMs = event.message.create_time ? parseInt(event.message.create_time, 10) : void 0;
    const isTopicSession = isGroup && (groupSession?.groupSessionScope === "group_topic" || groupSession?.groupSessionScope === "group_topic_sender");
    const configReplyInThread = isGroup && (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled";
    const replyTargetMessageId = isTopicSession || configReplyInThread ? ctx.rootId ?? ctx.messageId : ctx.messageId;
    const threadReply = isGroup ? groupSession?.threadReply ?? false : false;
    if (broadcastAgents) {
      if (!await tryRecordMessagePersistent(ctx.messageId, "broadcast", log)) {
        log(
          `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`
        );
        return;
      }
      const strategy = cfg.broadcast?.strategy || "parallel";
      const activeAgentId = ctx.mentionedBot || !requireMention ? normalizeAgentId(route.agentId) : null;
      const agentIds = (cfg.agents?.list ?? []).map((a) => normalizeAgentId(a.id));
      const hasKnownAgents = agentIds.length > 0;
      log(
        `feishu[${account.accountId}]: broadcasting to ${broadcastAgents.length} agents (strategy=${strategy}, active=${activeAgentId ?? "none"})`
      );
      const dispatchForAgent = async (agentId) => {
        if (hasKnownAgents && !agentIds.includes(normalizeAgentId(agentId))) {
          log(
            `feishu[${account.accountId}]: broadcast agent ${agentId} not found in agents.list; skipping`
          );
          return;
        }
        const agentSessionKey = buildBroadcastSessionKey(route.sessionKey, route.agentId, agentId);
        const agentCtx = await buildCtxPayloadForAgent(
          agentId,
          agentSessionKey,
          route.accountId,
          ctx.mentionedBot && agentId === activeAgentId
        );
        if (agentId === activeAgentId) {
          const identity = resolveAgentOutboundIdentity(cfg, agentId);
          const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
            cfg,
            agentId,
            runtime,
            chatId: ctx.chatId,
            replyToMessageId: replyTargetMessageId,
            skipReplyToInMessages: !isGroup,
            replyInThread,
            rootId: ctx.rootId,
            threadReply,
            mentionTargets: ctx.mentionTargets,
            accountId: account.accountId,
            identity,
            messageCreateTimeMs
          });
          log(
            `feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`
          );
          await core.channel.reply.withReplyDispatcher({
            dispatcher,
            onSettled: () => markDispatchIdle(),
            run: () => core.channel.reply.dispatchReplyFromConfig({
              ctx: agentCtx,
              cfg,
              dispatcher,
              replyOptions
            })
          });
        } else {
          delete agentCtx.CommandAuthorized;
          const noopDispatcher = {
            sendToolResult: () => false,
            sendBlockReply: () => false,
            sendFinalReply: () => false,
            waitForIdle: async () => {
            },
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            markComplete: () => {
            }
          };
          log(
            `feishu[${account.accountId}]: broadcast observer dispatch agent=${agentId} (session=${agentSessionKey})`
          );
          await core.channel.reply.withReplyDispatcher({
            dispatcher: noopDispatcher,
            run: () => core.channel.reply.dispatchReplyFromConfig({
              ctx: agentCtx,
              cfg,
              dispatcher: noopDispatcher
            })
          });
        }
      };
      if (strategy === "sequential") {
        for (const agentId of broadcastAgents) {
          try {
            await dispatchForAgent(agentId);
          } catch (err) {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(err)}`
            );
          }
        }
      } else {
        const results = await Promise.allSettled(broadcastAgents.map(dispatchForAgent));
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${broadcastAgents[i]}: ${String(results[i].reason)}`
            );
          }
        }
      }
      if (isGroup && historyKey && chatHistories) {
        clearHistoryEntriesIfEnabled({
          historyMap: chatHistories,
          historyKey,
          limit: historyLimit
        });
      }
      log(
        `feishu[${account.accountId}]: broadcast dispatch complete for ${broadcastAgents.length} agents`
      );
    } else {
      const ctxPayload = await buildCtxPayloadForAgent(
        route.agentId,
        route.sessionKey,
        route.accountId,
        ctx.mentionedBot
      );
      const identity = resolveAgentOutboundIdentity(cfg, route.agentId);
      const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime,
        chatId: ctx.chatId,
        replyToMessageId: replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: ctx.mentionTargets,
        accountId: account.accountId,
        identity,
        messageCreateTimeMs
      });
      log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);
      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () => core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions
        })
      });
      if (isGroup && historyKey && chatHistories) {
        clearHistoryEntriesIfEnabled({
          historyMap: chatHistories,
          historyKey,
          limit: historyLimit
        });
      }
      log(
        `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`
      );
    }
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}
export {
  buildBroadcastSessionKey,
  buildFeishuAgentBody,
  handleFeishuMessage,
  parseFeishuMessageEvent,
  resolveBroadcastAgents,
  toMessageResourceType
};
