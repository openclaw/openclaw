import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/msteams";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError
} from "./errors.js";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint
} from "./graph-upload.js";
import { extractFilename, extractMessageId } from "./media-helpers.js";
import { buildConversationReference, sendMSTeamsMessages } from "./messenger.js";
import { buildMSTeamsPollCard } from "./polls.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsSendContext } from "./send-context.js";
const FILE_CONSENT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;
async function sendMessageMSTeams(params) {
  const { cfg, to, text, mediaUrl, mediaLocalRoots } = params;
  const tableMode = getMSTeamsRuntime().channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "msteams"
  });
  const messageText = getMSTeamsRuntime().channel.text.convertMarkdownTables(text ?? "", tableMode);
  const ctx = await resolveMSTeamsSendContext({ cfg, to });
  const {
    adapter,
    appId,
    conversationId,
    ref,
    log,
    conversationType,
    tokenProvider,
    sharePointSiteId
  } = ctx;
  log.debug?.("sending proactive message", {
    conversationId,
    conversationType,
    textLength: messageText.length,
    hasMedia: Boolean(mediaUrl)
  });
  if (mediaUrl) {
    const mediaMaxBytes = ctx.mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
    const media = await loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: mediaMaxBytes,
      mediaLocalRoots
    });
    const isLargeFile = media.buffer.length >= FILE_CONSENT_THRESHOLD_BYTES;
    const isImage = media.contentType?.startsWith("image/") ?? false;
    const fallbackFileName = await extractFilename(mediaUrl);
    const fileName = media.fileName ?? fallbackFileName;
    log.debug?.("processing media", {
      fileName,
      contentType: media.contentType,
      size: media.buffer.length,
      isLargeFile,
      isImage,
      conversationType
    });
    if (requiresFileConsent({
      conversationType,
      contentType: media.contentType,
      bufferSize: media.buffer.length,
      thresholdBytes: FILE_CONSENT_THRESHOLD_BYTES
    })) {
      const { activity, uploadId } = prepareFileConsentActivity({
        media: { buffer: media.buffer, filename: fileName, contentType: media.contentType },
        conversationId,
        description: messageText || void 0
      });
      log.debug?.("sending file consent card", { uploadId, fileName, size: media.buffer.length });
      const messageId = await sendProactiveActivity({
        adapter,
        appId,
        ref,
        activity,
        errorPrefix: "msteams consent card send"
      });
      log.info("sent file consent card", { conversationId, messageId, uploadId });
      return {
        messageId,
        conversationId,
        pendingUploadId: uploadId
      };
    }
    if (conversationType === "personal") {
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;
      return sendTextWithMedia(ctx, messageText, finalMediaUrl);
    }
    if (isImage && !sharePointSiteId) {
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;
      return sendTextWithMedia(ctx, messageText, finalMediaUrl);
    }
    try {
      if (sharePointSiteId) {
        log.debug?.("uploading to SharePoint for native file card", {
          fileName,
          conversationType,
          siteId: sharePointSiteId
        });
        const uploaded2 = await uploadAndShareSharePoint({
          buffer: media.buffer,
          filename: fileName,
          contentType: media.contentType,
          tokenProvider,
          siteId: sharePointSiteId,
          chatId: conversationId,
          usePerUserSharing: conversationType === "groupChat"
        });
        log.debug?.("SharePoint upload complete", {
          itemId: uploaded2.itemId,
          shareUrl: uploaded2.shareUrl
        });
        const driveItem = await getDriveItemProperties({
          siteId: sharePointSiteId,
          itemId: uploaded2.itemId,
          tokenProvider
        });
        log.debug?.("driveItem properties retrieved", {
          eTag: driveItem.eTag,
          webDavUrl: driveItem.webDavUrl
        });
        const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
        const activity2 = {
          type: "message",
          text: messageText || void 0,
          attachments: [fileCardAttachment]
        };
        const messageId2 = await sendProactiveActivityRaw({
          adapter,
          appId,
          ref,
          activity: activity2
        });
        log.info("sent native file card", {
          conversationId,
          messageId: messageId2,
          fileName: driveItem.name
        });
        return { messageId: messageId2, conversationId };
      }
      log.debug?.("uploading to OneDrive (no SharePoint site configured)", {
        fileName,
        conversationType
      });
      const uploaded = await uploadAndShareOneDrive({
        buffer: media.buffer,
        filename: fileName,
        contentType: media.contentType,
        tokenProvider
      });
      log.debug?.("OneDrive upload complete", {
        itemId: uploaded.itemId,
        shareUrl: uploaded.shareUrl
      });
      const fileLink = `\u{1F4CE} [${uploaded.name}](${uploaded.shareUrl})`;
      const activity = {
        type: "message",
        text: messageText ? `${messageText}

${fileLink}` : fileLink
      };
      const messageId = await sendProactiveActivityRaw({
        adapter,
        appId,
        ref,
        activity
      });
      log.info("sent message with OneDrive file link", {
        conversationId,
        messageId,
        shareUrl: uploaded.shareUrl
      });
      return { messageId, conversationId };
    } catch (err) {
      const classification = classifyMSTeamsSendError(err);
      const hint = formatMSTeamsSendErrorHint(classification);
      const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
      throw new Error(
        `msteams file send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
        { cause: err }
      );
    }
  }
  return sendTextWithMedia(ctx, messageText, void 0);
}
async function sendTextWithMedia(ctx, text, mediaUrl) {
  const {
    adapter,
    appId,
    conversationId,
    ref,
    log,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes
  } = ctx;
  let messageIds;
  try {
    messageIds = await sendMSTeamsMessages({
      replyStyle: "top-level",
      adapter,
      appId,
      conversationRef: ref,
      messages: [{ text: text || void 0, mediaUrl }],
      retry: {},
      onRetry: (event) => {
        log.debug?.("retrying send", { conversationId, ...event });
      },
      tokenProvider,
      sharePointSiteId,
      mediaMaxBytes
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
      { cause: err }
    );
  }
  const messageId = messageIds[0] ?? "unknown";
  log.info("sent proactive message", { conversationId, messageId });
  return {
    messageId,
    conversationId
  };
}
async function sendProactiveActivityRaw({
  adapter,
  appId,
  ref,
  activity
}) {
  const baseRef = buildConversationReference(ref);
  const proactiveRef = {
    ...baseRef,
    activityId: void 0
  };
  let messageId = "unknown";
  await adapter.continueConversation(appId, proactiveRef, async (ctx) => {
    const response = await ctx.sendActivity(activity);
    messageId = extractMessageId(response) ?? "unknown";
  });
  return messageId;
}
async function sendProactiveActivity({
  adapter,
  appId,
  ref,
  activity,
  errorPrefix
}) {
  try {
    return await sendProactiveActivityRaw({
      adapter,
      appId,
      ref,
      activity
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `${errorPrefix} failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
      { cause: err }
    );
  }
}
async function sendPollMSTeams(params) {
  const { cfg, to, question, options, maxSelections } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to
  });
  const pollCard = buildMSTeamsPollCard({
    question,
    options,
    maxSelections
  });
  log.debug?.("sending poll", {
    conversationId,
    pollId: pollCard.pollId,
    optionCount: pollCard.options.length
  });
  const activity = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: pollCard.card
      }
    ]
  };
  const messageId = await sendProactiveActivity({
    adapter,
    appId,
    ref,
    activity,
    errorPrefix: "msteams poll send"
  });
  log.info("sent poll", { conversationId, pollId: pollCard.pollId, messageId });
  return {
    pollId: pollCard.pollId,
    messageId,
    conversationId
  };
}
async function sendAdaptiveCardMSTeams(params) {
  const { cfg, to, card } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to
  });
  log.debug?.("sending adaptive card", {
    conversationId,
    cardType: card.type,
    cardVersion: card.version
  });
  const activity = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card
      }
    ]
  };
  const messageId = await sendProactiveActivity({
    adapter,
    appId,
    ref,
    activity,
    errorPrefix: "msteams card send"
  });
  log.info("sent adaptive card", { conversationId, messageId });
  return {
    messageId,
    conversationId
  };
}
async function listMSTeamsConversations() {
  const store = createMSTeamsConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.user?.name,
    conversationType: reference.conversation?.conversationType
  }));
}
export {
  listMSTeamsConversations,
  sendAdaptiveCardMSTeams,
  sendMessageMSTeams,
  sendPollMSTeams
};
