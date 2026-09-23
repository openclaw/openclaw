import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import { copyReplyPayloadMetadata, type ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

// Keep sent-block media out of both delivery fields so outbound planning cannot restore it.
export function deduplicateBlockSentMedia<
  T extends Pick<ReplyPayload, "mediaUrl" | "mediaUrls" | "text" | "attachments">,
>(payload: T, sentBlockMediaUrls: ReadonlySet<string>): T | undefined {
  if (!payload.mediaUrls?.length || sentBlockMediaUrls.size === 0) {
    return payload;
  }
  const remainingMedia = payload.mediaUrls.filter((url) => !sentBlockMediaUrls.has(url));
  if (remainingMedia.length === payload.mediaUrls.length) {
    return payload;
  }
  if (remainingMedia.length === 0 && !payload.text) {
    return undefined;
  }
  const mediaUrl = sentBlockMediaUrls.has(payload.mediaUrl?.trim() ?? "")
    ? undefined
    : payload.mediaUrl;
  return copyReplyPayloadMetadata(payload, {
    ...payload,
    mediaUrls: remainingMedia,
    mediaUrl,
    ...(payload.attachments
      ? {
          attachments: collectReplyMediaEntries(payload, [
            ...remainingMedia,
            ...(mediaUrl ? [mediaUrl] : []),
          ]).map(({ attachment }) => attachment ?? {}),
        }
      : {}),
  });
}
