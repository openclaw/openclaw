import {
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments,
  downloadGraphHostedContent,
  downloadMSTeamsGraphMedia,
  type MSTeamsAccessTokenProvider,
  type MSTeamsAttachmentLike,
  type MSTeamsHtmlAttachmentSummary,
  type MSTeamsInboundMedia,
} from "../attachments.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type MSTeamsLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

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
  });

  // Teams represents inline pasted images as text/html attachments with hostedContents.
  // Always attempt the Graph hostedContents path when HTML attachments are present,
  // even if some regular file attachments already downloaded successfully,
  // because mixed messages can have both regular files and inline pasted images.
  const hasHtmlAttachments = attachments.some((att) =>
    String(att.contentType ?? "").startsWith("text/html"),
  );

  // Teams represents inline pasted images as text/html attachments with hostedContents.
  if (hasHtmlAttachments) {
    const messageUrls = buildMSTeamsGraphMessageUrls({
      conversationType,
      conversationId,
      messageId: activity.id ?? undefined,
      replyToId: activity.replyToId ?? undefined,
      conversationMessageId,
      channelData: activity.channelData,
    });
    if (messageUrls.length === 0) {
      log.debug?.("graph message url unavailable", {
        conversationType,
        hasChannelData: Boolean(activity.channelData),
        messageId: activity.id ?? undefined,
        replyToId: activity.replyToId ?? undefined,
      });
    } else if (mediaList.length > 0) {
      // Mixed message: we already have some media from direct downloads.
      // Only fetch hostedContents (inline images) to avoid duplicating attachments.
      for (const messageUrl of messageUrls) {
        try {
          const token = await tokenProvider.getAccessToken("https://graph.microsoft.com");
          if (!token) break;
          const hosted = await downloadGraphHostedContent({
            messageUrl,
            accessToken: token,
            maxBytes,
            preserveFilenames,
          });
          if (hosted.media.length > 0) {
            mediaList = [...mediaList, ...hosted.media];
            break;
          }
        } catch {
          // Token acquisition or Graph fetch failed — continue to next URL candidate.
        }
      }
    } else {
      // No media yet: try the full Graph path (hostedContents + attachments).
      const attempts: Array<{
        url: string;
        hostedStatus?: number;
        attachmentStatus?: number;
        hostedCount?: number;
        attachmentCount?: number;
        tokenError?: boolean;
      }> = [];
      for (const messageUrl of messageUrls) {
        const graphMedia = await downloadMSTeamsGraphMedia({
          messageUrl,
          tokenProvider,
          maxBytes,
          allowHosts,
          authAllowHosts: params.authAllowHosts,
          preserveFilenames,
        });
        attempts.push({
          url: messageUrl,
          hostedStatus: graphMedia.hostedStatus,
          attachmentStatus: graphMedia.attachmentStatus,
          hostedCount: graphMedia.hostedCount,
          attachmentCount: graphMedia.attachmentCount,
          tokenError: graphMedia.tokenError,
        });
        if (graphMedia.media.length > 0) {
          mediaList = graphMedia.media;
          break;
        }
        if (graphMedia.tokenError) {
          break;
        }
      }
      if (mediaList.length === 0) {
        log.debug?.("graph media fetch empty", { attempts });
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
