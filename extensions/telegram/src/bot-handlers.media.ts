// Telegram plugin module implements bot handlers.media behavior.
import type { Message } from "grammy/types";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";

export function isMediaSizeLimitError(err: unknown): boolean {
  const errMsg = String(err);
  return errMsg.includes("exceeds") && errMsg.includes("MB limit");
}

/**
 * Whether an inbound media fetch failure should be durably retried by the
 * ingress spool rather than acked-and-dropped. Deliberately distinct from
 * media/fetch.ts `shouldRetryMediaFetch`: that governs in-loop retry within a
 * single fetch and treats a shutdown abort as non-retryable (retrying mid-abort
 * is futile), but durable re-spool MUST retry it — a restart/shutdown abort is
 * the primary inbound-loss vector this guards (#98076). Transient covers network
 * and abort fetch failures plus 408/429/5xx HTTP; permanent covers size limits
 * and other 4xx, which never succeed on replay.
 */
export function isRetryableMediaFetchError(err: unknown): boolean {
  if (!(err instanceof MediaFetchError)) {
    return false;
  }
  if (err.code === "fetch_failed") {
    return true;
  }
  if (err.code === "http_error") {
    return (
      err.status === 408 ||
      err.status === 429 ||
      (typeof err.status === "number" && err.status >= 500)
    );
  }
  return false;
}

export function isRecoverableMediaGroupError(err: unknown): boolean {
  return err instanceof MediaFetchError || isMediaSizeLimitError(err);
}

export function hasInboundMedia(msg: Message): boolean {
  return (
    Boolean(msg.media_group_id) ||
    (Array.isArray(msg.photo) && msg.photo.length > 0) ||
    Boolean(msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker)
  );
}

export function resolveInboundMediaFileId(msg: Message): string | undefined {
  return (
    msg.sticker?.file_id ??
    msg.photo?.[msg.photo.length - 1]?.file_id ??
    msg.video?.file_id ??
    msg.video_note?.file_id ??
    msg.document?.file_id ??
    msg.audio?.file_id ??
    msg.voice?.file_id
  );
}
