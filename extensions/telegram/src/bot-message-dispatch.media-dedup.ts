/**
 * Deduplicate media URLs in a final-reply payload against media already
 * delivered via block replies. Returns the deduplicated payload, or
 * undefined if the payload should be skipped entirely (all media already
 * sent and no text remains).
 */
export function deduplicateBlockSentMedia<T extends { mediaUrls?: string[]; text?: string }>(
  payload: T,
  sentBlockMediaUrls: ReadonlySet<string>,
): T | undefined {
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
  return { ...payload, mediaUrls: remainingMedia };
}
