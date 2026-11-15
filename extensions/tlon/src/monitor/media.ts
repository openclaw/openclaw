import { MAX_IMAGE_BYTES, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { TLON_MEDIA_FETCH_TIMEOUTS } from "../media-fetch-timeouts.js";

const MAX_IMAGES_PER_MESSAGE = 8;

type TlonInboundMedia = { path: string; contentType: string };

/** Keeps Tlon's shipped path-duplicating prompt bytes paired with ordered facts. */
export function buildTlonInboundMediaPrompt(messageText: string, media: TlonInboundMedia[]) {
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

export async function downloadMessageImages(content: unknown, maxBytes?: number) {
  const images: string[] = [];
  const attachments: TlonInboundMedia[] = [];
  let unavailableCount = 0;

  // Retain the number omitted by the download cap for the unavailable-media notice.
  if (Array.isArray(content)) {
    for (const verse of content) {
      if (verse?.block?.image?.src) {
        if (images.length >= MAX_IMAGES_PER_MESSAGE) {
          unavailableCount++;
          continue;
        }
        images.push(verse.block.image.src);
      }
    }
  }

  for (const url of images) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        console.warn("[tlon-media] Rejected non-http(s) media URL");
        unavailableCount++;
        continue;
      }

      const saved = await saveRemoteMedia({
        url,
        maxBytes: Math.min(maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
        ...TLON_MEDIA_FETCH_TIMEOUTS,
        ssrfPolicy: undefined,
        requestInit: { method: "GET" },
      });
      attachments.push({
        path: saved.path,
        contentType: saved.contentType ?? "application/octet-stream",
      });
    } catch {
      console.error("[tlon-media] Error downloading inbound media");
      unavailableCount++;
    }
  }

  return { attachments, unavailableCount };
}
