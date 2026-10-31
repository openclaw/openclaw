import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { appendReplyMediaFailures } from "openclaw/plugin-sdk/reply-payload";
import { LocalMediaAccessError } from "openclaw/plugin-sdk/web-media";

/** Names an attachment by its file name, as reply preprocessing does for local failures. */
function describeMediaLabel(mediaUrl: string): string {
  let source = mediaUrl;
  try {
    source = new URL(mediaUrl).pathname;
  } catch {
    // Not a URL: a local path.
  }
  return source.split(/[\\/]/).findLast(Boolean) || "attachment";
}

/**
 * Preprocessing cannot check media that is only loaded during delivery, such as a remote URL.
 * When that load fails before any part of the reply went out, keep the answer text and add the
 * shared attachment receipt. Returns undefined when the error must still fail the reply.
 */
function resolveTelegramMediaLoadFallbackText(params: {
  error: unknown;
  text: string | undefined;
  mediaUrls: readonly string[];
  partlyDelivered: boolean;
}): string | undefined {
  const loadFailed =
    params.error instanceof MediaFetchError || params.error instanceof LocalMediaAccessError;
  if (!loadFailed || params.partlyDelivered) {
    return undefined;
  }
  return appendReplyMediaFailures(
    params.text,
    params.mediaUrls.map((mediaUrl) => ({
      code: "delivery-failed",
      kind: "document",
      label: describeMediaLabel(mediaUrl),
    })),
  );
}

type MediaDeliveryResult = {
  firstDeliveredMessageId?: number;
  visibleFallbackText?: string;
  mediaUrls: string[];
};

/** Delivers the media reply, falling back to its text plus a receipt on a delivery-time load failure. */
export async function deliverTelegramMediaWithTextFallback(params: {
  deliverMedia: () => Promise<MediaDeliveryResult>;
  deliverText: (text: string) => Promise<number | undefined>;
  text: string | undefined;
  mediaUrls: readonly string[];
  partlyDelivered: () => boolean;
  onFallback: (error: unknown) => void;
}): Promise<MediaDeliveryResult> {
  try {
    return await params.deliverMedia();
  } catch (error) {
    const text = resolveTelegramMediaLoadFallbackText({
      error,
      text: params.text,
      mediaUrls: params.mediaUrls,
      partlyDelivered: params.partlyDelivered(),
    });
    if (text === undefined) {
      throw error;
    }
    params.onFallback(error);
    const firstDeliveredMessageId = await params.deliverText(text);
    return { firstDeliveredMessageId, visibleFallbackText: text, mediaUrls: [] };
  }
}
