import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  type ChunkMode,
} from "openclaw/plugin-sdk/reply-chunking";
import {
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { MarkdownTableMode, MSTeamsReplyStyle } from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { MSTeamsSdkCloudOptions } from "./cloud.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { classifyMSTeamsSendError } from "./errors.js";
import { prepareFileConsentActivity, requiresFileConsent } from "./file-consent-helpers.js";
import { formatMSTeamsMarkdown } from "./format.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  requireMSTeamsSharePointSiteId,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import {
  extractFilename,
  extractMessageId,
  getMimeType,
  isLocalPath,
  MSTEAMS_MAX_MEDIA_BYTES,
} from "./media-helpers.js";
import { buildMSTeamsMessageActivity } from "./message-activity.js";
import { setPendingUploadActivityId } from "./pending-uploads.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import type { MSTeamsActivityLike } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";
import {
  assertMSTeamsSendHandoff,
  withMSTeamsConnectorHandoff,
  type MSTeamsSendHandoff,
} from "./send-handoff.js";

type MSTeamsReplyRenderOptions = {
  textChunkLimit: number;
  tableMode: MarkdownTableMode;
  chunkMode?: ChunkMode;
};

/**
 * A rendered message that preserves media vs text distinction.
 * When mediaUrl is present, it will be sent as a Bot Framework attachment.
 */
export type MSTeamsRenderedMessage = {
  text?: string;
  mediaUrl?: string;
};

const MSTEAMS_SEND_ATTEMPTS = 3;
const MSTEAMS_SEND_RETRY_MAX_DELAY_MS = 10_000;

type MSTeamsSendRetryEvent = {
  messageIndex: number;
  messageCount: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  classification: ReturnType<typeof classifyMSTeamsSendError>;
};

export function buildConversationReference(ref: StoredConversationReference) {
  const conversationId = ref.conversation?.id?.trim();
  if (!conversationId) {
    throw new Error("Invalid stored reference: missing conversation.id");
  }
  // Legacy imported rows may only carry `bot`; see StoredConversationReference.bot.
  const agent = ref.agent ?? ref.bot ?? undefined;
  if (agent == null || !agent.id) {
    throw new Error("Invalid stored reference: missing agent.id");
  }
  const user = ref.user;
  if (!user?.id) {
    throw new Error("Invalid stored reference: missing user.id");
  }
  // Bot Framework proactive sends require `tenantId` on the outbound activity
  // so the connector routes to the correct Azure AD tenant; otherwise it rejects
  // with HTTP 403. Prefer the explicit top-level `ref.tenantId` (captured from
  // `channelData.tenant.id` inbound) and fall back to `conversation.tenantId`.
  const tenantId = ref.tenantId ?? ref.conversation?.tenantId;
  const aadObjectId = ref.aadObjectId ?? user.aadObjectId;
  return {
    activityId: ref.activityId,
    user: aadObjectId ? { ...user, aadObjectId } : user,
    agent,
    conversation: {
      id: normalizeMSTeamsConversationId(conversationId),
      conversationType: ref.conversation?.conversationType,
      tenantId,
    },
    channelId: ref.channelId ?? "msteams",
    serviceUrl: ref.serviceUrl,
    locale: ref.locale,
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
  };
}

export function renderReplyPayloadsToMessages(
  replies: ReplyPayload[],
  options: MSTeamsReplyRenderOptions,
): MSTeamsRenderedMessage[] {
  const out: MSTeamsRenderedMessage[] = [];
  const chunkLimit = Math.min(options.textChunkLimit, 4000);
  const chunkMode = options.chunkMode ?? "length";

  for (const payload of replies) {
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: formatMSTeamsMarkdown(payload.text ?? "", options.tableMode),
    });

    if (!reply.hasContent) {
      continue;
    }

    if (reply.text) {
      const chunks = getMSTeamsRuntime().channel.text.chunkMarkdownTextWithMode(
        reply.text,
        chunkLimit,
        chunkMode,
      );
      for (const chunk of chunks) {
        const text = chunk.trim();
        if (text && !isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
          out.push({ text });
        }
      }
    }
    out.push(...reply.mediaUrls.map((mediaUrl) => ({ mediaUrl })));
  }

  return out;
}

async function buildActivity(
  msg: MSTeamsRenderedMessage,
  conversationRef: StoredConversationReference,
  tokenProvider?: MSTeamsAccessTokenProvider,
  sharePointSiteId?: string,
  mediaMaxBytes?: number,
  options?: { feedbackLoopEnabled?: boolean } & MSTeamsSendHandoff,
): Promise<Record<string, unknown>> {
  const activity: Record<string, unknown> = buildMSTeamsMessageActivity(msg.text);

  // Mark as AI-generated so Teams renders the "AI generated" badge.
  activity.channelData = {
    feedbackLoopEnabled: options?.feedbackLoopEnabled ?? false,
  };

  if (msg.mediaUrl) {
    let contentUrl = msg.mediaUrl;
    let contentType = await getMimeType(msg.mediaUrl);
    let fileName = await extractFilename(msg.mediaUrl);

    if (isLocalPath(msg.mediaUrl)) {
      const maxBytes = mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES;
      const media = await loadWebMedia(msg.mediaUrl, maxBytes);
      contentType = media.contentType ?? contentType;
      fileName = media.fileName ?? fileName;

      // Teams only accepts base64 data URLs for images
      const conversationType = normalizeOptionalLowercaseString(
        conversationRef.conversation?.conversationType,
      );
      const isPersonal = conversationType === "personal";
      const isImage = media.kind === "image";

      if (
        requiresFileConsent({
          conversationType,
          contentType,
          bufferSize: media.buffer.length,
        })
      ) {
        const conversationId = conversationRef.conversation?.id ?? "unknown";
        assertMSTeamsSendHandoff(options);
        const { activity: consentActivity, uploadId } = prepareFileConsentActivity({
          media: { buffer: media.buffer, filename: fileName, contentType },
          conversationId,
          description: msg.text || undefined,
        });

        // Tag the activity so the caller can store the activity ID after sending
        consentActivity["_pendingUploadId"] = uploadId;

        return consentActivity;
      }

      if (!isPersonal && !isImage) {
        // Non-images in group chats/channels require SharePoint because an
        // application token has no signed-in `/me/drive` to fall back to.
        const siteId = requireMSTeamsSharePointSiteId(sharePointSiteId);
        if (!tokenProvider) {
          throw new Error("MS Teams Graph token provider unavailable for SharePoint file send");
        }
        const chatId = conversationRef.conversation?.id;

        const uploaded = await uploadAndShareSharePoint({
          assertDirectAdapterHandoff: options?.assertDirectAdapterHandoff,
          buffer: media.buffer,
          filename: fileName,
          contentType,
          tokenProvider,
          siteId,
          chatId: chatId ?? undefined,
          usePerUserSharing: conversationType === "groupchat",
        });

        const driveItem = await getDriveItemProperties({
          assertDirectAdapterHandoff: options?.assertDirectAdapterHandoff,
          siteId,
          itemId: uploaded.itemId,
          tokenProvider,
        });

        activity.attachments = [buildTeamsFileInfoCard(driveItem)];

        return activity;
      }

      // Image (any chat): use base64 (works for images in all conversation types)
      const base64 = media.buffer.toString("base64");
      contentUrl = `data:${media.contentType};base64,${base64}`;
    }

    activity.attachments = [
      {
        name: fileName,
        contentType,
        contentUrl,
      },
    ];
  }

  return activity;
}

export async function sendMSTeamsMessages(
  params: {
    replyStyle: MSTeamsReplyStyle;
    app: MSTeamsApp;
    conversationRef: StoredConversationReference;
    context?: { sendActivity: (activity: MSTeamsActivityLike) => Promise<unknown> };
    messages: MSTeamsRenderedMessage[];
    onRetry?: (event: MSTeamsSendRetryEvent) => void;
    onMessageSent?: (messageId: string, messageIndex: number) => Promise<void> | void;
    /** Token provider for SharePoint uploads in group chats/channels */
    tokenProvider?: MSTeamsAccessTokenProvider;
    /** SharePoint site ID for file uploads in group chats/channels */
    sharePointSiteId?: string;
    /** Max media size in bytes. Default: 100MB. */
    mediaMaxBytes?: number;
    /** Enable the Teams feedback loop (thumbs up/down) on sent messages. */
    feedbackLoopEnabled?: boolean;
    serviceUrlBoundary?: MSTeamsSdkCloudOptions;
  } & MSTeamsSendHandoff,
): Promise<string[]> {
  const messages = params.messages.filter(
    (m) => (m.text && m.text.trim().length > 0) || m.mediaUrl,
  );
  if (messages.length === 0) {
    return [];
  }

  let providerDispatchStarted = false;
  const sendMessageInContext = async (
    sendFn: (activity: MSTeamsActivityLike) => Promise<unknown>,
    message: MSTeamsRenderedMessage,
    messageIndex: number,
  ): Promise<string> => {
    let activity: Record<string, unknown> | undefined;
    let pendingUploadId: string | undefined;
    let response: unknown;
    try {
      response = await retryAsync(
        async () => {
          assertMSTeamsSendHandoff(params);
          // Retry failed preparation, but keep its successful I/O and SharePoint work
          // out of subsequent provider retries.
          activity ??= await buildActivity(
            message,
            params.conversationRef,
            params.tokenProvider,
            params.sharePointSiteId,
            params.mediaMaxBytes,
            {
              feedbackLoopEnabled: params.feedbackLoopEnabled,
              assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
            },
          );

          pendingUploadId ??=
            typeof activity["_pendingUploadId"] === "string"
              ? activity["_pendingUploadId"]
              : undefined;
          delete activity["_pendingUploadId"];

          assertMSTeamsSendHandoff(params);
          providerDispatchStarted = true;
          return await sendFn(activity);
        },
        {
          attempts: MSTEAMS_SEND_ATTEMPTS,
          minDelayMs: 0,
          maxDelayMs: MSTEAMS_SEND_RETRY_MAX_DELAY_MS,
          shouldRetry: (err) => classifyMSTeamsSendError(err).kind === "replay-safe",
          delayMs: ({ attempt, err }) => {
            const classification = classifyMSTeamsSendError(err);
            const retryAfterMs =
              classification.kind === "replay-safe" ? classification.retryAfterMs : undefined;
            return Math.min(
              retryAfterMs ?? 250 * 2 ** (attempt - 1),
              MSTEAMS_SEND_RETRY_MAX_DELAY_MS,
            );
          },
          onRetry: ({ attempt, err, delayMs }) => {
            params.onRetry?.({
              messageIndex,
              messageCount: messages.length,
              nextAttempt: attempt + 1,
              maxAttempts: MSTEAMS_SEND_ATTEMPTS,
              delayMs,
              classification: classifyMSTeamsSendError(err),
            });
          },
          sleep: (delayMs) => sleepWithAbort(delayMs),
        },
      );
    } catch (error) {
      if (!providerDispatchStarted && !(error instanceof PlatformMessageNotDispatchedError)) {
        throw new PlatformMessageNotDispatchedError(
          error instanceof Error ? error.message : "Teams activity preparation failed",
          { cause: error },
        );
      }
      throw error;
    }
    const messageId = extractMessageId(response) ?? "unknown";
    await params.onMessageSent?.(messageId, messageIndex);

    // Store the activity ID so the accept handler can replace the consent card in-place
    if (pendingUploadId && messageId !== "unknown") {
      setPendingUploadActivityId(pendingUploadId, messageId);
    }

    return messageId;
  };

  const sendProactively = async (
    batch: MSTeamsRenderedMessage[],
    startIndex: number,
    threadActivityId?: string,
  ): Promise<string[]> => {
    let baseRef: ReturnType<typeof buildConversationReference>;
    try {
      baseRef = buildConversationReference(params.conversationRef);
    } catch (error) {
      if (providerDispatchStarted) {
        throw error;
      }
      throw new PlatformMessageNotDispatchedError(
        error instanceof Error ? error.message : "Teams conversation preparation failed",
        { cause: error },
      );
    }
    const isChannel = params.conversationRef.conversation?.conversationType === "channel";
    const sendFn = (activity: MSTeamsActivityLike) =>
      sendMSTeamsActivityWithReference(params.app, baseRef, activity, {
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
        threadActivityId: isChannel ? threadActivityId : undefined,
        serviceUrlBoundary: params.serviceUrlBoundary,
      });
    const messageIds: string[] = [];
    for (const [idx, message] of batch.entries()) {
      messageIds.push(await sendMessageInContext(sendFn, message, startIndex + idx));
    }
    return messageIds;
  };

  // Resolve the thread root message ID for channel thread routing.
  // `threadId` is the canonical thread root (set on inbound for channel threads);
  // fall back to `activityId` for backward compatibility with older stored refs.
  const resolvedThreadId = params.conversationRef.threadId ?? params.conversationRef.activityId;

  if (params.replyStyle === "thread") {
    const ctx = params.context;
    if (!ctx) {
      return await sendProactively(messages, 0, resolvedThreadId);
    }
    const sendFn = (activity: MSTeamsActivityLike) =>
      withMSTeamsConnectorHandoff(params, () => ctx.sendActivity(activity));
    const messageIds: string[] = [];
    for (const [idx, message] of messages.entries()) {
      const result = await withRevokedProxyFallback({
        run: async () => ({
          ids: [await sendMessageInContext(sendFn, message, idx)],
          fellBack: false,
        }),
        onRevoked: async () => {
          // When the live turn context is revoked (e.g. debounced messages),
          // reconstruct the threaded conversation ID so the proactive
          // fallback delivers the reply into the correct channel thread.
          return {
            ids: await sendProactively(messages.slice(idx), idx, resolvedThreadId),
            fellBack: true,
          };
        },
      });
      messageIds.push(...result.ids);
      if (result.fellBack) {
        return messageIds;
      }
    }
    return messageIds;
  }

  // Top-level replies deliberately omit the stored thread root.
  return await sendProactively(messages, 0);
}
