// Msteams plugin module implements inbound media behavior.
import { formatInboundMediaUnavailableText } from "openclaw/plugin-sdk/channel-inbound";
import {
  buildMSTeamsGraphMessageUrl,
  downloadMSTeamsAttachments,
  downloadMSTeamsBotFrameworkAttachments,
  downloadMSTeamsGraphMedia,
  extractMSTeamsHtmlAttachmentIds,
  isBotFrameworkPersonalChatId,
  type MSTeamsAccessTokenProvider,
  type MSTeamsAttachmentLike,
  type MSTeamsHtmlAttachmentSummary,
  type MSTeamsInboundMedia,
} from "../attachments.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type MSTeamsLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
};

export function resolveMSTeamsInboundMediaBody(params: {
  body: string;
  mediaPlaceholder: string;
  materializedMediaPlaceholder: string;
  expectedMediaCount: number;
  mediaCount: number;
}): string {
  const unavailableCount = Math.max(0, params.expectedMediaCount - params.mediaCount);
  if (unavailableCount === 0) {
    return params.body;
  }
  const body =
    params.mediaCount > 0 && params.body === params.mediaPlaceholder
      ? params.materializedMediaPlaceholder
      : params.body;
  return formatInboundMediaUnavailableText({
    body,
    mediaPlaceholder: params.mediaCount === 0 ? params.mediaPlaceholder : undefined,
    notice: `[msteams ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
  });
}

export async function resolveMSTeamsInboundMedia(params: {
  attachments: MSTeamsAttachmentLike[];
  htmlSummary?: MSTeamsHtmlAttachmentSummary;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  tokenProvider: MSTeamsAccessTokenProvider;
  conversationType: string;
  conversationId: string;
  conversationMessageId?: string;
  serviceUrl?: string;
  activity: Pick<MSTeamsTurnContext["activity"], "id" | "replyToId" | "channelData">;
  log: MSTeamsLogger;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsInboundMedia[]> {
  const {
    attachments,
    htmlSummary,
    maxBytes,
    tokenProvider,
    allowHosts,
    conversationType,
    conversationId,
    conversationMessageId,
    serviceUrl,
    activity,
    log,
    preserveFilenames,
  } = params;

  let mediaList = await downloadMSTeamsAttachments({
    attachments,
    maxBytes,
    tokenProvider,
    allowHosts,
    authAllowHosts: params.authAllowHosts,
    preserveFilenames,
    logger: log,
  });

  if (mediaList.length === 0) {
    // Explicit attachment markers remain the fallback gate for personal chats.
    // Channel and group-chat activities can omit them while Graph holds a file.
    const attachmentIds = extractMSTeamsHtmlAttachmentIds(attachments);
    const hasHtmlFileAttachment = attachmentIds.length > 0;
    const normalizedConversationType = conversationType.trim().toLowerCase();
    const hasChannelOrGroupHtml =
      (normalizedConversationType === "channel" || normalizedConversationType === "groupchat") &&
      (htmlSummary?.htmlAttachments ?? 0) > 0;
    const shouldFetchGraphMessage = hasHtmlFileAttachment || hasChannelOrGroupHtml;

    // Personal DMs with the bot use Bot Framework conversation IDs (`a:...`
    // or `8:orgid:...`) which Graph's `/chats/{id}` endpoint rejects with
    // "Invalid ThreadId". Fetch media via the Bot Framework v3 attachments
    // endpoint instead, which speaks the same identifier space.
    if (hasHtmlFileAttachment && isBotFrameworkPersonalChatId(conversationId)) {
      if (!serviceUrl) {
        log.debug?.("bot framework attachment skipped (missing serviceUrl)", {
          conversationType,
          conversationId,
        });
      } else {
        const bfMedia = await downloadMSTeamsBotFrameworkAttachments({
          serviceUrl,
          attachmentIds,
          tokenProvider,
          maxBytes,
          allowHosts,
          authAllowHosts: params.authAllowHosts,
          preserveFilenames,
        });
        if (bfMedia.media.length > 0) {
          mediaList = bfMedia.media;
        } else {
          log.debug?.("bot framework attachments fetch empty", {
            conversationType,
            attachmentCount: bfMedia.attachmentCount ?? attachmentIds.length,
          });
        }
      }
    }

    if (
      shouldFetchGraphMessage &&
      mediaList.length === 0 &&
      !isBotFrameworkPersonalChatId(conversationId)
    ) {
      const messageUrl = buildMSTeamsGraphMessageUrl({
        conversationType,
        conversationId,
        messageId: activity.id ?? undefined,
        threadRootMessageId: conversationMessageId ?? activity.replyToId,
        teamAadGroupId: activity.channelData?.team?.aadGroupId,
        channelId: activity.channelData?.channel?.id,
      });
      if (!messageUrl) {
        log.debug?.("graph message url unavailable", {
          conversationType,
          hasChannelData: Boolean(activity.channelData),
          messageId: activity.id ?? undefined,
          replyToId: activity.replyToId ?? undefined,
        });
      } else {
        const graphMedia = await downloadMSTeamsGraphMedia({
          messageUrl,
          tokenProvider,
          maxBytes,
          allowHosts,
          authAllowHosts: params.authAllowHosts,
          preserveFilenames,
          log,
          logger: log,
        });
        if (graphMedia.media.length > 0) {
          mediaList = graphMedia.media;
        }
        if (mediaList.length === 0) {
          log.debug?.("graph media fetch empty", {
            messageUrl,
            hostedStatus: graphMedia.hostedStatus,
            attachmentStatus: graphMedia.attachmentStatus,
            hostedCount: graphMedia.hostedCount,
            attachmentCount: graphMedia.attachmentCount,
            tokenError: graphMedia.tokenError,
            attachmentIdCount: attachmentIds.length,
          });
        }
      }
    }
  }

  if (mediaList.length > 0) {
    log.debug?.("downloaded attachments", { count: mediaList.length });
  } else if (htmlSummary?.imgTags) {
    log.debug?.("inline images detected but none downloaded", {
      imgTags: htmlSummary.imgTags,
      srcHosts: htmlSummary.srcHosts,
      dataImages: htmlSummary.dataImages,
      cidImages: htmlSummary.cidImages,
    });
  }

  return mediaList;
}
