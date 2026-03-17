import {
  isSilentReplyText,
  loadWebMedia,
  SILENT_REPLY_TOKEN,
  sleep
} from "openclaw/plugin-sdk/msteams";
import { classifyMSTeamsSendError } from "./errors.js";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint
} from "./graph-upload.js";
import { extractFilename, extractMessageId, getMimeType, isLocalPath } from "./media-helpers.js";
import { parseMentions } from "./mentions.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;
function normalizeConversationId(rawId) {
  return rawId.split(";")[0] ?? rawId;
}
function buildConversationReference(ref) {
  const conversationId = ref.conversation?.id?.trim();
  if (!conversationId) {
    throw new Error("Invalid stored reference: missing conversation.id");
  }
  const agent = ref.agent ?? ref.bot ?? void 0;
  if (agent == null || !agent.id) {
    throw new Error("Invalid stored reference: missing agent.id");
  }
  const user = ref.user;
  if (!user?.id) {
    throw new Error("Invalid stored reference: missing user.id");
  }
  return {
    activityId: ref.activityId,
    user,
    agent,
    conversation: {
      id: normalizeConversationId(conversationId),
      conversationType: ref.conversation?.conversationType,
      tenantId: ref.conversation?.tenantId
    },
    channelId: ref.channelId ?? "msteams",
    serviceUrl: ref.serviceUrl,
    locale: ref.locale
  };
}
function pushTextMessages(out, text, opts) {
  if (!text) {
    return;
  }
  if (opts.chunkText) {
    for (const chunk of getMSTeamsRuntime().channel.text.chunkMarkdownTextWithMode(
      text,
      opts.chunkLimit,
      opts.chunkMode
    )) {
      const trimmed2 = chunk.trim();
      if (!trimmed2 || isSilentReplyText(trimmed2, SILENT_REPLY_TOKEN)) {
        continue;
      }
      out.push({ text: trimmed2 });
    }
    return;
  }
  const trimmed = text.trim();
  if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
    return;
  }
  out.push({ text: trimmed });
}
function clampMs(value, maxMs) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, maxMs);
}
function resolveRetryOptions(retry) {
  if (!retry) {
    return { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };
  }
  return {
    enabled: true,
    maxAttempts: Math.max(1, retry?.maxAttempts ?? 3),
    baseDelayMs: Math.max(0, retry?.baseDelayMs ?? 250),
    maxDelayMs: Math.max(0, retry?.maxDelayMs ?? 1e4)
  };
}
function computeRetryDelayMs(attempt, classification, opts) {
  if (classification.retryAfterMs != null) {
    return clampMs(classification.retryAfterMs, opts.maxDelayMs);
  }
  const exponential = opts.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return clampMs(exponential, opts.maxDelayMs);
}
function shouldRetry(classification) {
  return classification.kind === "throttled" || classification.kind === "transient";
}
function renderReplyPayloadsToMessages(replies, options) {
  const out = [];
  const chunkLimit = Math.min(options.textChunkLimit, 4e3);
  const chunkText = options.chunkText !== false;
  const chunkMode = options.chunkMode ?? "length";
  const mediaMode = options.mediaMode ?? "split";
  const tableMode = options.tableMode ?? getMSTeamsRuntime().channel.text.resolveMarkdownTableMode({
    cfg: getMSTeamsRuntime().config.loadConfig(),
    channel: "msteams"
  });
  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = getMSTeamsRuntime().channel.text.convertMarkdownTables(
      payload.text ?? "",
      tableMode
    );
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      pushTextMessages(out, text, { chunkText, chunkLimit, chunkMode });
      continue;
    }
    if (mediaMode === "inline") {
      const firstMedia = mediaList[0];
      if (firstMedia) {
        out.push({ text: text || void 0, mediaUrl: firstMedia });
        for (let i = 1; i < mediaList.length; i++) {
          if (mediaList[i]) {
            out.push({ mediaUrl: mediaList[i] });
          }
        }
      } else {
        pushTextMessages(out, text, { chunkText, chunkLimit, chunkMode });
      }
      continue;
    }
    pushTextMessages(out, text, { chunkText, chunkLimit, chunkMode });
    for (const mediaUrl of mediaList) {
      if (!mediaUrl) {
        continue;
      }
      out.push({ mediaUrl });
    }
  }
  return out;
}
async function buildActivity(msg, conversationRef, tokenProvider, sharePointSiteId, mediaMaxBytes) {
  const activity = { type: "message" };
  if (msg.text) {
    const { text: formattedText, entities } = parseMentions(msg.text);
    activity.text = formattedText;
    if (entities.length > 0) {
      activity.entities = entities;
    }
  }
  if (msg.mediaUrl) {
    let contentUrl = msg.mediaUrl;
    let contentType = await getMimeType(msg.mediaUrl);
    let fileName = await extractFilename(msg.mediaUrl);
    if (isLocalPath(msg.mediaUrl)) {
      const maxBytes = mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
      const media = await loadWebMedia(msg.mediaUrl, maxBytes);
      contentType = media.contentType ?? contentType;
      fileName = media.fileName ?? fileName;
      const conversationType = conversationRef.conversation?.conversationType?.toLowerCase();
      const isPersonal = conversationType === "personal";
      const isImage = media.kind === "image";
      if (requiresFileConsent({
        conversationType,
        contentType,
        bufferSize: media.buffer.length,
        thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES
      })) {
        const conversationId = conversationRef.conversation?.id ?? "unknown";
        const { activity: consentActivity } = prepareFileConsentActivity({
          media: { buffer: media.buffer, filename: fileName, contentType },
          conversationId,
          description: msg.text || void 0
        });
        return consentActivity;
      }
      if (!isPersonal && !isImage && tokenProvider && sharePointSiteId) {
        const chatId = conversationRef.conversation?.id;
        const uploaded = await uploadAndShareSharePoint({
          buffer: media.buffer,
          filename: fileName,
          contentType,
          tokenProvider,
          siteId: sharePointSiteId,
          chatId: chatId ?? void 0,
          usePerUserSharing: conversationType === "groupchat"
        });
        const driveItem = await getDriveItemProperties({
          siteId: sharePointSiteId,
          itemId: uploaded.itemId,
          tokenProvider
        });
        const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
        activity.attachments = [fileCardAttachment];
        return activity;
      }
      if (!isPersonal && media.kind !== "image" && tokenProvider) {
        const uploaded = await uploadAndShareOneDrive({
          buffer: media.buffer,
          filename: fileName,
          contentType,
          tokenProvider
        });
        const fileLink = `\u{1F4CE} [${uploaded.name}](${uploaded.shareUrl})`;
        const existingText = typeof activity.text === "string" ? activity.text : void 0;
        activity.text = existingText ? `${existingText}

${fileLink}` : fileLink;
        return activity;
      }
      const base64 = media.buffer.toString("base64");
      contentUrl = `data:${media.contentType};base64,${base64}`;
    }
    activity.attachments = [
      {
        name: fileName,
        contentType,
        contentUrl
      }
    ];
  }
  return activity;
}
async function sendMSTeamsMessages(params) {
  const messages = params.messages.filter(
    (m) => m.text && m.text.trim().length > 0 || m.mediaUrl
  );
  if (messages.length === 0) {
    return [];
  }
  const retryOptions = resolveRetryOptions(params.retry);
  const sendWithRetry = async (sendOnce, meta) => {
    if (!retryOptions.enabled) {
      return await sendOnce();
    }
    let attempt = 1;
    while (true) {
      try {
        return await sendOnce();
      } catch (err) {
        const classification = classifyMSTeamsSendError(err);
        const canRetry = attempt < retryOptions.maxAttempts && shouldRetry(classification);
        if (!canRetry) {
          throw err;
        }
        const delayMs = computeRetryDelayMs(attempt, classification, retryOptions);
        const nextAttempt = attempt + 1;
        params.onRetry?.({
          messageIndex: meta.messageIndex,
          messageCount: meta.messageCount,
          nextAttempt,
          maxAttempts: retryOptions.maxAttempts,
          delayMs,
          classification
        });
        await sleep(delayMs);
        attempt = nextAttempt;
      }
    }
  };
  const sendMessageInContext = async (ctx, message, messageIndex) => {
    const response = await sendWithRetry(
      async () => await ctx.sendActivity(
        await buildActivity(
          message,
          params.conversationRef,
          params.tokenProvider,
          params.sharePointSiteId,
          params.mediaMaxBytes
        )
      ),
      { messageIndex, messageCount: messages.length }
    );
    return extractMessageId(response) ?? "unknown";
  };
  const sendMessageBatchInContext = async (ctx, batch, startIndex) => {
    const messageIds = [];
    for (const [idx, message] of batch.entries()) {
      messageIds.push(await sendMessageInContext(ctx, message, startIndex + idx));
    }
    return messageIds;
  };
  const sendProactively = async (batch, startIndex) => {
    const baseRef = buildConversationReference(params.conversationRef);
    const proactiveRef = {
      ...baseRef,
      activityId: void 0
    };
    const messageIds = [];
    await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
      messageIds.push(...await sendMessageBatchInContext(ctx, batch, startIndex));
    });
    return messageIds;
  };
  if (params.replyStyle === "thread") {
    const ctx = params.context;
    if (!ctx) {
      throw new Error("Missing context for replyStyle=thread");
    }
    const messageIds = [];
    for (const [idx, message] of messages.entries()) {
      const result = await withRevokedProxyFallback({
        run: async () => ({
          ids: [await sendMessageInContext(ctx, message, idx)],
          fellBack: false
        }),
        onRevoked: async () => {
          const remaining = messages.slice(idx);
          return {
            ids: remaining.length > 0 ? await sendProactively(remaining, idx) : [],
            fellBack: true
          };
        }
      });
      messageIds.push(...result.ids);
      if (result.fellBack) {
        return messageIds;
      }
    }
    return messageIds;
  }
  return await sendProactively(messages, 0);
}
export {
  buildConversationReference,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages
};
