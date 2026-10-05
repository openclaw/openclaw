import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { OutboundMediaLoadOptions } from "openclaw/plugin-sdk/outbound-media";
import { loadOutboundMediaFromUrl, type OpenClawConfig } from "../runtime-api.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  FILE_CONSENT_THRESHOLD_BYTES,
  prepareFileConsentActivityFs,
  requiresFileConsent,
} from "./file-consent-helpers.js";
import { formatMSTeamsMarkdown } from "./format.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  requireMSTeamsSharePointSiteId,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import { extractFilename, extractMessageId, MSTEAMS_MAX_MEDIA_BYTES } from "./media-helpers.js";
import {
  buildMSTeamsAdaptiveCardActivity,
  buildMSTeamsMessageActivity,
} from "./message-activity.js";
import { buildConversationReference, sendMSTeamsMessages } from "./messenger.js";
import { setPendingUploadActivityIdFs } from "./pending-uploads-fs.js";
import { setPendingUploadActivityId } from "./pending-uploads.js";
import { buildMSTeamsPollCard } from "./polls.js";
import {
  deleteMSTeamsActivityWithReference,
  sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference,
} from "./sdk-proactive.js";
import { resolveMSTeamsSendContext, type MSTeamsProactiveContext } from "./send-context.js";
import { assertMSTeamsSendHandoff, type MSTeamsSendHandoff } from "./send-handoff.js";

type MSTeamsSendOptions = MSTeamsSendHandoff & {
  onDeliveryResult?: (result: SendMSTeamsMessageResult) => Promise<void> | void;
};

type SendMSTeamsMessageParams = {
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  text: string;
  mediaUrl?: string;
  /** Optional filename override for uploaded media/files */
  filename?: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
} & MSTeamsSendOptions;

type SendMSTeamsMessageResult = {
  messageId: string;
  conversationId: string;
  receipt: MessageReceipt;
  /** If a FileConsentCard was sent instead of the file, this contains the upload ID */
  pendingUploadId?: string;
};

function createMSTeamsSendError(errorPrefix: string, error: unknown): Error {
  if (
    error instanceof Error &&
    (error instanceof PlatformMessageNotDispatchedError || isChannelPartialDeliveryError(error))
  ) {
    return error;
  }
  const classification = classifyMSTeamsSendError(error);
  const hint = formatMSTeamsSendErrorHint(classification);
  const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
  return new Error(
    `${errorPrefix} failed${status}: ${formatUnknownError(error)}${hint ? ` (${hint})` : ""}`,
    { cause: error },
  );
}

function createMSTeamsPartialSendError(error: unknown, receipt: MessageReceipt) {
  return createChannelPartialDeliveryError(error, {
    visibleReplySent: true,
    messageIds: receipt.platformMessageIds,
    receipt,
  });
}

async function finishMSTeamsSend(
  result: SendMSTeamsMessageResult,
  settle: () => Promise<void>,
): Promise<SendMSTeamsMessageResult> {
  try {
    await settle();
  } catch (error) {
    throw createMSTeamsPartialSendError(error, result.receipt);
  }
  return result;
}

function createMSTeamsSendReceipt(params: {
  conversationId: string;
  platformMessageIds: readonly string[];
  kind: MessageReceiptPartKind;
  kinds?: readonly MessageReceiptPartKind[];
}) {
  const receipt = createMessageReceiptFromOutboundResults({
    kind: params.kind,
    results: params.platformMessageIds.map((messageId) => ({
      channel: "msteams",
      messageId,
      conversationId: params.conversationId,
    })),
  });
  if (params.kinds) {
    for (const [index, part] of receipt.parts.entries()) {
      part.kind = params.kinds[index] ?? params.kind;
    }
  }
  return receipt;
}

function createMSTeamsSendResult(params: {
  conversationId: string;
  messageId: string;
  kind: MessageReceiptPartKind;
  pendingUploadId?: string;
}): SendMSTeamsMessageResult {
  const platformMessageIds = [params.messageId]
    .map((messageId) => messageId.trim())
    .filter((messageId) => messageId && messageId !== "unknown");
  return {
    messageId: params.messageId,
    conversationId: params.conversationId,
    receipt: createMSTeamsSendReceipt({
      conversationId: params.conversationId,
      platformMessageIds,
      kind: params.kind,
    }),
    ...(params.pendingUploadId ? { pendingUploadId: params.pendingUploadId } : {}),
  };
}

type SendMSTeamsPollParams = {
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  question: string;
  options: string[];
  /** Max selections (defaults to 1) */
  maxSelections?: number;
} & MSTeamsSendHandoff;

type SendMSTeamsPollResult = {
  pollId: string;
  messageId: string;
  conversationId: string;
};

type SendMSTeamsCardParams = {
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  card: Record<string, unknown>;
} & MSTeamsSendOptions;

/** Proactive delivery requires a conversation reference captured from an earlier inbound turn. */
export async function sendMessageMSTeams(
  params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  assertMSTeamsSendHandoff(params);
  const { cfg, to, text, mediaUrl, filename, mediaAccess, mediaLocalRoots, mediaReadFile } = params;
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "msteams",
  });
  const messageText = formatMSTeamsMarkdown(text ?? "", tableMode);
  const ctx = await resolveMSTeamsSendContext({ cfg, to });
  const { conversationId, log, conversationType, tokenProvider, sharePointSiteId } = ctx;

  log.debug?.("sending proactive message", {
    conversationId,
    conversationType,
    textLength: messageText.length,
    hasMedia: Boolean(mediaUrl),
  });

  if (mediaUrl) {
    const mediaMaxBytes = ctx.mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
    const media = await loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: mediaMaxBytes,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    });
    const isLargeFile = media.buffer.length >= FILE_CONSENT_THRESHOLD_BYTES;
    const isImage = media.contentType?.startsWith("image/") ?? false;
    const fallbackFileName = await extractFilename(mediaUrl);
    const fileName = filename?.trim() || media.fileName || fallbackFileName;

    log.debug?.("processing media", {
      fileName,
      contentType: media.contentType,
      size: media.buffer.length,
      isLargeFile,
      isImage,
      conversationType,
    });

    // Personal chats: base64 only works for images; use FileConsentCard for large files or non-images
    if (
      requiresFileConsent({
        conversationType,
        contentType: media.contentType,
        bufferSize: media.buffer.length,
      })
    ) {
      // Persist consent bytes so the Gateway can receive the callback after this process exits.
      assertMSTeamsSendHandoff(params);
      const { activity, uploadId } = await prepareFileConsentActivityFs({
        media: { buffer: media.buffer, filename: fileName, contentType: media.contentType },
        conversationId,
        description: messageText || undefined,
      });

      log.debug?.("sending file consent card", { uploadId, fileName, size: media.buffer.length });

      const messageId = await sendProactiveActivity({
        ctx,
        activity,
        errorPrefix: "msteams consent card send",
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
      });

      // Store the activity ID so the accept handler can replace the consent
      // card in-place. Mirror it into the FS store too because the invoke
      // callback may be delivered to a different process than the CLI send.
      const result = createMSTeamsSendResult({
        messageId,
        conversationId,
        kind: "card",
        pendingUploadId: uploadId,
      });
      return finishMSTeamsSend(result, async () => {
        setPendingUploadActivityId(uploadId, messageId);
        try {
          await params.onDeliveryResult?.(result);
        } finally {
          await setPendingUploadActivityIdFs(uploadId, messageId);
        }
        log.info("sent file consent card", { conversationId, messageId, uploadId });
      });
    }

    if (conversationType === "personal" || (isImage && !sharePointSiteId)) {
      // Personal-chat files needing consent were handled above.
      // Group chat/channel images can be sent inline without SharePoint storage.
      const base64 = media.buffer.toString("base64");
      const finalMediaUrl = `data:${media.contentType};base64,${base64}`;
      return sendTextWithMedia(ctx, messageText, finalMediaUrl, params);
    }

    // Group chat or channel: upload to configured SharePoint storage.
    try {
      const siteId = requireMSTeamsSharePointSiteId(sharePointSiteId);
      log.debug?.("uploading to SharePoint for native file card", {
        fileName,
        conversationType,
        siteId,
      });

      const uploaded = await uploadAndShareSharePoint({
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        buffer: media.buffer,
        filename: fileName,
        contentType: media.contentType,
        tokenProvider,
        siteId,
        chatId: conversationId,
        usePerUserSharing: conversationType === "groupChat",
      });

      log.debug?.("SharePoint upload complete", {
        itemId: uploaded.itemId,
        shareUrl: uploaded.shareUrl,
      });

      const driveItem = await getDriveItemProperties({
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        siteId,
        itemId: uploaded.itemId,
        tokenProvider,
      });

      log.debug?.("driveItem properties retrieved", {
        eTag: driveItem.eTag,
        webDavUrl: driveItem.webDavUrl,
      });

      const fileCardAttachment = buildTeamsFileInfoCard(driveItem);
      const activity = {
        ...buildMSTeamsMessageActivity(messageText || undefined),
        attachments: [fileCardAttachment],
      };
      const messageId = await sendProactiveActivityRaw({
        ctx,
        activity,
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
      });

      log.info("sent native file card", {
        conversationId,
        messageId,
        fileName: driveItem.name,
      });

      const result = createMSTeamsSendResult({
        messageId,
        conversationId,
        kind: "media",
      });
      return await finishMSTeamsSend(result, async () => {
        await params.onDeliveryResult?.(result);
      });
    } catch (err) {
      throw createMSTeamsSendError("msteams file send", err);
    }
  }

  return sendTextWithMedia(ctx, messageText, undefined, params);
}

async function sendTextWithMedia(
  ctx: MSTeamsProactiveContext,
  text: string,
  mediaUrl: string | undefined,
  options: MSTeamsSendOptions,
): Promise<SendMSTeamsMessageResult> {
  const {
    app,
    conversationId,
    ref,
    log,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes,
    replyStyle,
  } = ctx;
  const messages =
    text && mediaUrl ? [{ text }, { mediaUrl }] : [{ text: text || undefined, mediaUrl }];

  let platformMessageIds: string[];
  const acceptedIds: string[] = [];
  const acceptedKinds: MessageReceiptPartKind[] = [];
  try {
    platformMessageIds = await sendMSTeamsMessages({
      assertDirectAdapterHandoff: options.assertDirectAdapterHandoff,
      onPlatformSendDispatch: options.onPlatformSendDispatch,
      onMessageSent: async (messageId, messageIndex) => {
        const kind = messages[messageIndex]?.mediaUrl ? "media" : "text";
        acceptedIds.push(messageId);
        acceptedKinds.push(kind);
        await options.onDeliveryResult?.(
          createMSTeamsSendResult({ conversationId, messageId, kind }),
        );
      },
      replyStyle,
      app,
      conversationRef: ref,
      messages,
      onRetry: (event) => {
        log.debug?.("retrying send", { conversationId, ...event });
      },
      tokenProvider,
      sharePointSiteId,
      mediaMaxBytes,
      serviceUrlBoundary: ctx.sdkCloudOptions,
    });
  } catch (err) {
    const error = createMSTeamsSendError("msteams send", err);
    if (acceptedIds.length > 0) {
      throw createMSTeamsPartialSendError(
        error,
        createMSTeamsSendReceipt({
          conversationId,
          platformMessageIds: acceptedIds,
          kind: mediaUrl ? "media" : "text",
          kinds: acceptedKinds,
        }),
      );
    }
    throw error;
  }

  const messageId = platformMessageIds[0] ?? "unknown";
  log.info("sent proactive message", { conversationId, messageId });

  return {
    messageId,
    conversationId,
    receipt: createMSTeamsSendReceipt({
      conversationId,
      platformMessageIds,
      kind: mediaUrl ? "media" : "text",
      ...(text && mediaUrl ? { kinds: ["text", "media"] } : {}),
    }),
  };
}

type ProactiveActivityParams = {
  ctx: MSTeamsProactiveContext;
  activity: Record<string, unknown>;
  errorPrefix: string;
} & MSTeamsSendHandoff;

type ProactiveActivityRawParams = Omit<ProactiveActivityParams, "errorPrefix">;

async function sendProactiveActivityRaw({
  ctx,
  activity,
  assertDirectAdapterHandoff,
  onPlatformSendDispatch,
}: ProactiveActivityRawParams): Promise<string> {
  const baseRef = buildConversationReference(ctx.ref);
  const response = await sendMSTeamsActivityWithReference(ctx.app, baseRef, activity, {
    assertDirectAdapterHandoff,
    onPlatformSendDispatch,
    ...(ctx.threadActivityId ? { threadActivityId: ctx.threadActivityId } : {}),
    serviceUrlBoundary: ctx.sdkCloudOptions,
  });
  return extractMessageId(response) ?? "unknown";
}

async function sendProactiveActivity(params: ProactiveActivityParams): Promise<string> {
  try {
    return await sendProactiveActivityRaw(params);
  } catch (err) {
    throw createMSTeamsSendError(params.errorPrefix, err);
  }
}

export async function sendPollMSTeams(
  params: SendMSTeamsPollParams,
): Promise<SendMSTeamsPollResult> {
  assertMSTeamsSendHandoff(params);
  const { cfg, to, question, options, maxSelections } = params;
  const ctx = await resolveMSTeamsSendContext({
    cfg,
    to,
  });
  const { conversationId, log } = ctx;

  const pollCard = buildMSTeamsPollCard({
    question,
    options,
    maxSelections,
  });

  log.debug?.("sending poll", {
    conversationId,
    pollId: pollCard.pollId,
    optionCount: pollCard.options.length,
  });

  const activity = buildMSTeamsAdaptiveCardActivity(pollCard.card);

  const messageId = await sendProactiveActivity({
    ctx,
    activity,
    errorPrefix: "msteams poll send",
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
  });

  log.info("sent poll", { conversationId, pollId: pollCard.pollId, messageId });

  return {
    pollId: pollCard.pollId,
    messageId,
    conversationId,
  };
}

export async function sendAdaptiveCardMSTeams(
  params: SendMSTeamsCardParams,
): Promise<SendMSTeamsMessageResult> {
  assertMSTeamsSendHandoff(params);
  const { cfg, to, card } = params;
  const ctx = await resolveMSTeamsSendContext({
    cfg,
    to,
  });
  const { conversationId, log } = ctx;

  log.debug?.("sending adaptive card", {
    conversationId,
    cardType: card.type,
    cardVersion: card.version,
  });

  const activity = buildMSTeamsAdaptiveCardActivity(card);

  const messageId = await sendProactiveActivity({
    ctx,
    activity,
    errorPrefix: "msteams card send",
    assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
  });

  log.info("sent adaptive card", { conversationId, messageId });

  const result = createMSTeamsSendResult({
    messageId,
    conversationId,
    kind: "card",
  });
  return finishMSTeamsSend(result, async () => {
    await params.onDeliveryResult?.(result);
  });
}

type MSTeamsMessageMutationParams = {
  cfg: OpenClawConfig;
  /** Conversation ID or user ID */
  to: string;
  /** Activity ID of the message to edit or delete */
  activityId: string;
};

type MSTeamsMessageMutationResult = {
  conversationId: string;
};

export async function editMessageMSTeams(
  params: MSTeamsMessageMutationParams & { text: string },
): Promise<MSTeamsMessageMutationResult> {
  return mutateMSTeamsMessageActivity({
    ...params,
    activity: {
      ...buildMSTeamsMessageActivity(
        formatMSTeamsMarkdown(
          params.text,
          resolveMarkdownTableMode({ cfg: params.cfg, channel: "msteams" }),
        ),
      ),
      id: params.activityId,
    },
  });
}

export async function editAdaptiveCardMSTeams(
  params: MSTeamsMessageMutationParams & { card: Record<string, unknown> },
): Promise<MSTeamsMessageMutationResult> {
  return mutateMSTeamsMessageActivity({
    ...params,
    activity: {
      ...buildMSTeamsAdaptiveCardActivity(params.card),
      id: params.activityId,
    },
  });
}

export async function deleteMessageMSTeams(
  params: MSTeamsMessageMutationParams,
): Promise<MSTeamsMessageMutationResult> {
  return mutateMSTeamsMessageActivity(params);
}

async function mutateMSTeamsMessageActivity(
  params: MSTeamsMessageMutationParams & { activity?: Record<string, unknown> },
): Promise<MSTeamsMessageMutationResult> {
  const { cfg, to, activityId, activity } = params;
  const { app, conversationId, ref, log, sdkCloudOptions } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  const operation = activity ? "edit" : "delete";
  log.debug?.(`${activity ? "editing" : "deleting"} proactive message`, {
    conversationId,
    activityId,
  });

  try {
    const baseRef = buildConversationReference(ref);
    const options = { serviceUrlBoundary: sdkCloudOptions };
    if (activity) {
      await updateMSTeamsActivityWithReference(app, baseRef, activityId, activity, options);
    } else {
      await deleteMSTeamsActivityWithReference(app, baseRef, activityId, options);
    }
  } catch (err) {
    throw createMSTeamsSendError(`msteams ${operation}`, err);
  }

  log.info(`${activity ? "edited" : "deleted"} proactive message`, { conversationId, activityId });

  return { conversationId };
}
