import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { MAX_IMAGE_BYTES, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { TLON_MEDIA_FETCH_TIMEOUTS } from "../media-fetch-timeouts.js";

const MAX_IMAGES_PER_MESSAGE = 8;

type TlonInboundMedia = { path: string; contentType: string };

/** Keeps Tlon's shipped path-duplicating prompt bytes paired with ordered facts. */
export function buildTlonInboundMediaPrompt(
  messageText: string,
  attachments: readonly TlonInboundMedia[],
) {
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

// Retain the number omitted by the download cap for the unavailable-media notice.
function extractImageBlocks(content: unknown) {
  if (!Array.isArray(content)) {
    return { images: [], unavailableCount: 0 };
  }

  const images: string[] = [];
  let unavailableCount = 0;

  for (const verse of content) {
    if (verse?.block?.image?.src) {
      if (images.length >= MAX_IMAGES_PER_MESSAGE) {
        unavailableCount++;
        continue;
      }
      images.push(verse.block.image.src);
    }
  }

  return { images, unavailableCount };
}

async function downloadMedia(url: string, maxBytes?: number): Promise<TlonInboundMedia | null> {
  try {
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
      path: saved.path,
      contentType: saved.contentType ?? "application/octet-stream",
    };
  } catch (error: unknown) {
    console.error(`[tlon-media] Error downloading ${url}: ${formatErrorMessage(error)}`);
    return null;
  }
}

export async function downloadMessageImages(content: unknown, maxBytes?: number) {
  const { images, unavailableCount: overCapCount } = extractImageBlocks(content);
  const attachments: TlonInboundMedia[] = [];
  let unavailableCount = overCapCount;

  for (const url of images) {
    const downloaded = await downloadMedia(url, maxBytes);
    if (downloaded) {
      attachments.push(downloaded);
    } else {
      unavailableCount++;
    }
  }

  return { attachments, unavailableCount };
}
