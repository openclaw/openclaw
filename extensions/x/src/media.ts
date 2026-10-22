import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import type { XMediaUploadParams } from "./media-api.js";

type XMedia = Pick<XMediaUploadParams, "buffer" | "contentType" | "fileName" | "mediaCategory">;

// Keep buffered uploads bounded on the Gateway, independently of X's larger account limits.
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export async function loadXMedia(
  urls: readonly string[],
  access: Pick<OutboundMediaLoadOptions, "mediaAccess" | "mediaLocalRoots" | "mediaReadFile">,
  signal?: AbortSignal,
): Promise<XMedia[]> {
  try {
    if (urls.length > 4) {
      throw new Error("X supports up to four images or one video/GIF per reply.");
    }
    const loaded: XMedia[] = [];
    for (const url of urls) {
      signal?.throwIfAborted();
      const media = await loadOutboundMediaFromUrl(url, {
        ...access,
        maxBytes: MAX_VIDEO_BYTES,
        optimizeImages: false,
        requestInit: { signal },
      });
      const contentType = media.contentType ?? "";
      const mediaCategory =
        contentType === "video/mp4"
          ? "tweet_video"
          : contentType === "image/gif"
            ? "tweet_gif"
            : ["image/jpeg", "image/png", "image/webp"].includes(contentType)
              ? "tweet_image"
              : undefined;
      if (!mediaCategory) {
        throw new Error("X attachments must be JPEG, PNG, WebP, GIF, or MP4 video.");
      }
      const maxBytes =
        mediaCategory === "tweet_video"
          ? MAX_VIDEO_BYTES
          : (mediaCategory === "tweet_gif" ? 15 : 5) * 1024 * 1024;
      if (media.buffer.length > maxBytes) {
        throw new Error(
          `X ${mediaCategory} exceeds the ${maxBytes / (1024 * 1024)} MiB attachment limit.`,
        );
      }
      if (urls.length > 1 && mediaCategory !== "tweet_image") {
        throw new Error(
          "X video and GIF replies require exactly one attachment; do not mix them with images.",
        );
      }
      loaded.push({
        buffer: media.buffer,
        contentType,
        fileName: media.fileName ?? "proof",
        mediaCategory,
      });
    }
    return loaded;
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      cause instanceof Error ? cause.message : "X attachment could not be loaded",
      { cause, retryable: false },
    );
  }
}
