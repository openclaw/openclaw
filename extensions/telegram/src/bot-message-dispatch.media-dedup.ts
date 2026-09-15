// Keep sent-block media out of both delivery fields so outbound planning cannot restore it.
export function deduplicateBlockSentMedia<
  T extends { mediaUrl?: string; mediaUrls?: string[]; text?: string },
>(
  payload: T,
  sentBlockMediaUrls: ReadonlySet<string>,
  sentBlockMediaTexts?: ReadonlySet<string>,
): T | undefined {
  if (!payload.mediaUrls?.length || sentBlockMediaUrls.size === 0) {
    return payload;
  }
  const remainingMedia = payload.mediaUrls.filter((url) => !sentBlockMediaUrls.has(url));
  if (remainingMedia.length === payload.mediaUrls.length) {
    return payload;
  }
  const textTrimmed = payload.text?.trim();
  const textAlreadySent = textTrimmed ? sentBlockMediaTexts?.has(textTrimmed) : false;
  if (remainingMedia.length === 0 && (!textTrimmed || textAlreadySent)) {
    return undefined;
  }
  return {
    ...payload,
    mediaUrls: remainingMedia,
    mediaUrl: sentBlockMediaUrls.has(payload.mediaUrl?.trim() ?? "") ? undefined : payload.mediaUrl,
  };
}
