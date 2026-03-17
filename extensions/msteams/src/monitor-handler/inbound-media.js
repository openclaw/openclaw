import {
  buildMSTeamsGraphMessageUrls,
  downloadMSTeamsAttachments,
  downloadMSTeamsGraphMedia
} from "../attachments.js";
async function resolveMSTeamsInboundMedia(params) {
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
    preserveFilenames
  } = params;
  let mediaList = await downloadMSTeamsAttachments({
    attachments,
    maxBytes,
    tokenProvider,
    allowHosts,
    authAllowHosts: params.authAllowHosts,
    preserveFilenames
  });
  if (mediaList.length === 0) {
    const onlyHtmlAttachments = attachments.length > 0 && attachments.every((att) => String(att.contentType ?? "").startsWith("text/html"));
    if (onlyHtmlAttachments) {
      const messageUrls = buildMSTeamsGraphMessageUrls({
        conversationType,
        conversationId,
        messageId: activity.id ?? void 0,
        replyToId: activity.replyToId ?? void 0,
        conversationMessageId,
        channelData: activity.channelData
      });
      if (messageUrls.length === 0) {
        log.debug?.("graph message url unavailable", {
          conversationType,
          hasChannelData: Boolean(activity.channelData),
          messageId: activity.id ?? void 0,
          replyToId: activity.replyToId ?? void 0
        });
      } else {
        const attempts = [];
        for (const messageUrl of messageUrls) {
          const graphMedia = await downloadMSTeamsGraphMedia({
            messageUrl,
            tokenProvider,
            maxBytes,
            allowHosts,
            authAllowHosts: params.authAllowHosts,
            preserveFilenames
          });
          attempts.push({
            url: messageUrl,
            hostedStatus: graphMedia.hostedStatus,
            attachmentStatus: graphMedia.attachmentStatus,
            hostedCount: graphMedia.hostedCount,
            attachmentCount: graphMedia.attachmentCount,
            tokenError: graphMedia.tokenError
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
  }
  if (mediaList.length > 0) {
    log.debug?.("downloaded attachments", { count: mediaList.length });
  } else if (htmlSummary?.imgTags) {
    log.debug?.("inline images detected but none downloaded", {
      imgTags: htmlSummary.imgTags,
      srcHosts: htmlSummary.srcHosts,
      dataImages: htmlSummary.dataImages,
      cidImages: htmlSummary.cidImages
    });
  }
  return mediaList;
}
export {
  resolveMSTeamsInboundMedia
};
