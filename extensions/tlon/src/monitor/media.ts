import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { MAX_IMAGE_BYTES, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { TLON_MEDIA_FETCH_TIMEOUTS } from "../media-fetch-timeouts.js";

const MAX_IMAGES_PER_MESSAGE = 8;

type ExtractedImages = { images: Array<{ url: string }>; unavailableCount: number };
type DownloadedMedia = { localPath: string; contentType: string };
type TlonInboundMedia = { path: string; contentType: string };
type TlonInboundMediaDownload = { attachments: TlonInboundMedia[]; unavailableCount: number };

/** Keeps Tlon's shipped path-duplicating prompt bytes paired with ordered facts. */
export function buildTlonInboundMediaPrompt(
  messageText: string,
  attachments: readonly TlonInboundMedia[],
): { body: string; media: TlonInboundMedia[] } {
  const media = attachments.map((attachment) => ({ ...attachment }));
  if (media.length === 0) {
    return { body: messageText, media };
  }
  const mediaLines = media
    .map(
      (attachment) =>
        `[media attached: ${attachment.path} (${attachment.contentType}) | ${attachment.path}]`,
    )
    .join("\n");
  return { body: `${mediaLines}\n${messageText}`, media };
}

/**
 * Extract image blocks from Tlon message content.
 * Returns up to the download cap plus the number omitted by that cap.
 */
function extractImageBlocks(content: unknown): ExtractedImages {
  if (!content || !Array.isArray(content)) {
    return { images: [], unavailableCount: 0 };
  }

  const images: Array<{ url: string }> = [];
  let unavailableCount = 0;

  for (const verse of content) {
    if (verse?.block?.image?.src) {
      if (images.length >= MAX_IMAGES_PER_MESSAGE) {
        unavailableCount++;
        continue;
      }
      images.push({ url: verse.block.image.src });
    }
  }

  return { images, unavailableCount };
}

/**
 * Download a media file from URL to local storage.
 * Returns the local path where the file was saved.
 */
async function downloadMedia(url: string, maxBytes?: number): Promise<DownloadedMedia | null> {
  try {
    // Validate URL is http/https before fetching
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      console.warn(`[tlon-media] Rejected non-http(s) URL: ${url}`);
      return null;
    }

    const saved = await saveRemoteMedia({
      url,
      maxBytes: Math.min(maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
      ...TLON_MEDIA_FETCH_TIMEOUTS,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });
    return {
      localPath: saved.path,
      contentType: saved.contentType ?? "application/octet-stream",
    };
  } catch (error: unknown) {
    console.error(`[tlon-media] Error downloading ${url}: ${formatErrorMessage(error)}`);
    return null;
  }
}

/**
 * Download all images from a message and return attachment metadata.
 * Format matches OpenClaw's expected attachment structure.
 */
export async function downloadMessageImages(
  content: unknown,
  maxBytes?: number,
): Promise<TlonInboundMediaDownload> {
  const { images, unavailableCount: overCapCount } = extractImageBlocks(content);
  const attachments: TlonInboundMedia[] = [];
  let unavailableCount = overCapCount;

  for (const image of images) {
    const downloaded = await downloadMedia(image.url, maxBytes);
    if (downloaded) {
      attachments.push({
        path: downloaded.localPath,
        contentType: downloaded.contentType,
      });
    } else {
      unavailableCount++;
    }
  }

  return { attachments, unavailableCount };
}
