import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
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
  resolveMSTeamsSharePointSiteId,
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
import {
  buildMSTeamsAdaptiveCardActivity,
  buildMSTeamsMessageActivity,
} from "./message-activity.js";
import { setPendingUploadActivityId } from "./pending-uploads.js";
import { buildMSTeamsPresentationCard } from "./presentation.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import type { MSTeamsActivityLike } from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";
import {
  assertMSTeamsSendHandoff,
  withMSTeamsConnectorHandoff,
  type MSTeamsSendHandoff,
} from "./send-handoff.js";

/**
 * A rendered message that preserves media vs text distinction.
 * When mediaUrl is present, it will be sent as a Bot Framework attachment.
 */
export type MSTeamsRenderedMessage = {
  text?: string;
  mediaUrl?: string;
  adaptiveCard?: Record<string, unknown>;
};

const MSTEAMS_SEND_ATTEMPTS = 3;
const MSTEAMS_SEND_RETRY_MAX_DELAY_MS = 10_000;

export function buildConversationReference(ref: StoredConversationReference) {
  const conversationId = ref.conversation?.id?.trim();
  if (!conversationId) {
    throw new Error("Invalid stored reference: missing conversation.id");
  }
  // Legacy imported rows may only carry `bot`; see StoredConversationReference.bot.
  const agent = ref.agent ?? ref.bot;
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
  options: {
    textChunkLimit: number;
    tableMode: MarkdownTableMode;
    chunkMode?: ChunkMode;
  },
): MSTeamsRenderedMessage[] {
  const out: MSTeamsRenderedMessage[] = [];
  const chunkLimit = Math.min(options.textChunkLimit, 4000);
  const chunkMode = options.chunkMode ?? "length";

  for (const payload of replies) {
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: formatMSTeamsMarkdown(payload.text ?? "", options.tableMode),
    });

    if (!reply.hasContent && !payload.presentation) {
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
        if (text) {
          out.push({ text });
        }
      }
    }
    if (payload.presentation) {
      out.push({
        adaptiveCard: buildMSTeamsPresentationCard({ presentation: payload.presentation }),
      });
    }
    out.push(...reply.mediaUrls.map((mediaUrl) => ({ mediaUrl })));
  }

  return out;
}

export async function sendMSTeamsMessages(
  params: {
    replyStyle: MSTeamsReplyStyle;
    accountId?: string | null;
    app: MSTeamsApp;
    conversationRef: StoredConversationReference;
    context?: { sendActivity: (activity: MSTeamsActivityLike) => Promise<unknown> };
    messages: MSTeamsRenderedMessage[];
    onRetry?: (event: {
      messageIndex: number;
      messageCount: number;
      nextAttempt: number;
      maxAttempts: number;
      delayMs: number;
      classification: ReturnType<typeof classifyMSTeamsSendError>;
    }) => void;
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
    (m) => (m.text && m.text.trim().length > 0) || m.mediaUrl || m.adaptiveCard,
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
    async function buildActivity(): Promise<{
      activity: Record<string, unknown>;
      pendingUploadId?: string;
    }> {
      const msg = message;
      const { conversationRef, tokenProvider, sharePointSiteId, mediaMaxBytes } = params;
      const options = {
        feedbackLoopEnabled: params.feedbackLoopEnabled,
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
      };
      const activity: Record<string, unknown> = buildMSTeamsMessageActivity(msg.text);
      if (msg.adaptiveCard) {
        Object.assign(activity, buildMSTeamsAdaptiveCardActivity(msg.adaptiveCard));
      }

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

            return { activity: consentActivity, pendingUploadId: uploadId };
          }

          if (!isPersonal && !isImage) {
            // Non-images in group chats/channels require SharePoint because an
            // application token has no signed-in `/me/drive` to fall back to.
            if (!tokenProvider) {
              throw new Error("MS Teams Graph token provider unavailable for SharePoint file send");
            }
            const siteId = await resolveMSTeamsSharePointSiteId({
              ...options,
              siteId: sharePointSiteId,
              accountId: params.accountId,
              app: params.app,
              conversationRef,
              tokenProvider,
              serviceUrlBoundary: params.serviceUrlBoundary,
            });
            const chatId = conversationRef.conversation?.id;

            const uploaded = await uploadAndShareSharePoint({
              assertDirectAdapterHandoff: options?.assertDirectAdapterHandoff,
              buffer: media.buffer,
              filename: fileName,
              contentType,
              tokenProvider,
              siteId,
              chatId,
              usePerUserSharing: conversationType === "groupchat",
            });

            const driveItem = await getDriveItemProperties({
              assertDirectAdapterHandoff: options?.assertDirectAdapterHandoff,
              siteId,
              itemId: uploaded.itemId,
              tokenProvider,
            });

            activity.attachments = [buildTeamsFileInfoCard(driveItem)];

            return { activity };
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

      return { activity };
    }
    let prepared: Awaited<ReturnType<typeof buildActivity>> | undefined;
    let response: unknown;
    try {
      response = await retryAsync(
        async () => {
          assertMSTeamsSendHandoff(params);
          // Retry failed preparation, but keep its successful I/O and SharePoint work
          // out of subsequent provider retries.
          prepared ??= await buildActivity();

          assertMSTeamsSendHandoff(params);
          providerDispatchStarted = true;
          return await sendFn(prepared.activity);
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
    const pendingUploadId = prepared?.pendingUploadId;
    if (pendingUploadId && messageId !== "unknown") {
      setPendingUploadActivityId(pendingUploadId, messageId);
    }

    return messageId;
  };

  let sendFn: (activity: MSTeamsActivityLike) => Promise<unknown>;
  const ctx = params.replyStyle === "thread" ? params.context : undefined;
  if (ctx) {
    sendFn = (activity) => withMSTeamsConnectorHandoff(params, () => ctx.sendActivity(activity));
  } else {
    let baseRef: ReturnType<typeof buildConversationReference>;
    try {
      baseRef = buildConversationReference(params.conversationRef);
    } catch (error) {
      throw new PlatformMessageNotDispatchedError(
        error instanceof Error ? error.message : "Teams conversation preparation failed",
        { cause: error },
      );
    }
    const isChannel = params.conversationRef.conversation?.conversationType === "channel";
    // `threadId` is canonical; older stored references only carry `activityId`.
    // Top-level replies deliberately omit the stored thread root.
    const threadActivityId =
      params.replyStyle === "thread" && isChannel
        ? (params.conversationRef.threadId ?? params.conversationRef.activityId)
        : undefined;
    sendFn = (activity) =>
      sendMSTeamsActivityWithReference(params.app, baseRef, activity, {
        accountId: params.accountId,
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        onPlatformSendDispatch: params.onPlatformSendDispatch,
        threadActivityId,
        serviceUrlBoundary: params.serviceUrlBoundary,
      });
  }
  const messageIds: string[] = [];
  for (const [idx, message] of messages.entries()) {
    messageIds.push(await sendMessageInContext(sendFn, message, idx));
  }
  return messageIds;
}
