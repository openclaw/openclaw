import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/tlon";
import { getDefaultSsrFPolicy } from "../urbit/context.js";
const DEFAULT_MEDIA_DIR = path.join(homedir(), ".openclaw", "workspace", "media", "inbound");
function extractImageBlocks(content) {
  if (!content || !Array.isArray(content)) {
    return [];
  }
  const images = [];
  for (const verse of content) {
    if (verse?.block?.image?.src) {
      images.push({
        url: verse.block.image.src,
        alt: verse.block.image.alt
      });
    }
  }
  return images;
}
async function downloadMedia(url, mediaDir = DEFAULT_MEDIA_DIR) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      console.warn(`[tlon-media] Rejected non-http(s) URL: ${url}`);
      return null;
    }
    await mkdir(mediaDir, { recursive: true });
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: { method: "GET" },
      policy: getDefaultSsrFPolicy(),
      auditContext: "tlon-media-download"
    });
    try {
      if (!response.ok) {
        console.error(`[tlon-media] Failed to fetch ${url}: ${response.status}`);
        return null;
      }
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const ext = getExtensionFromContentType(contentType) || getExtensionFromUrl(url) || "bin";
      const filename = `${randomUUID()}.${ext}`;
      const localPath = path.join(mediaDir, filename);
      const body = response.body;
      if (!body) {
        console.error(`[tlon-media] No response body for ${url}`);
        return null;
      }
      const writeStream = createWriteStream(localPath);
      await pipeline(Readable.fromWeb(body), writeStream);
      return {
        localPath,
        contentType,
        originalUrl: url
      };
    } finally {
      await release();
    }
  } catch (error) {
    console.error(`[tlon-media] Error downloading ${url}: ${error?.message ?? String(error)}`);
    return null;
  }
}
function getExtensionFromContentType(contentType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg"
  };
  return map[contentType.split(";")[0].trim()] ?? null;
}
function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}
async function downloadMessageImages(content, mediaDir) {
  const images = extractImageBlocks(content);
  if (images.length === 0) {
    return [];
  }
  const attachments = [];
  for (const image of images) {
    const downloaded = await downloadMedia(image.url, mediaDir);
    if (downloaded) {
      attachments.push({
        path: downloaded.localPath,
        contentType: downloaded.contentType
      });
    }
  }
  return attachments;
}
export {
  downloadMedia,
  downloadMessageImages,
  extractImageBlocks
};
