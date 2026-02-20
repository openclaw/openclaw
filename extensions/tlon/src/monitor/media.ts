import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getDefaultSsrFPolicy } from "../urbit/context.js";
import { urbitFetch } from "../urbit/fetch.js";

// Default to OpenClaw workspace media directory
const DEFAULT_MEDIA_DIR = path.join(homedir(), ".openclaw", "workspace", "media", "inbound");

export interface ExtractedImage {
  url: string;
  alt?: string;
}

export interface DownloadedMedia {
  localPath: string;
  contentType: string;
  originalUrl: string;
}

/**
 * Extract image blocks from Tlon message content.
 * Returns array of image URLs found in the message.
 */
export function extractImageBlocks(content: unknown): ExtractedImage[] {
  if (!content || !Array.isArray(content)) {
    return [];
  }

  const images: ExtractedImage[] = [];

  for (const verse of content) {
    if (verse?.block?.image?.src) {
      images.push({
        url: verse.block.image.src,
        alt: verse.block.image.alt,
      });
    }
  }

  return images;
}

/**
 * Download a media file from URL to local storage.
 * Returns the local path where the file was saved.
 */
export async function downloadMedia(
  url: string,
  mediaDir: string = DEFAULT_MEDIA_DIR,
): Promise<DownloadedMedia | null> {
  try {
    // Validate URL is http/https before fetching
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      console.warn(`[tlon-media] Rejected non-http(s) URL: ${url}`);
      return null;
    }

    // Ensure media directory exists
    await mkdir(mediaDir, { recursive: true });

    // Fetch with SSRF protection
    const { response } = await urbitFetch({
      baseUrl: url,
      path: "",
      init: { method: "GET" },
      ssrfPolicy: getDefaultSsrFPolicy(),
      auditContext: "tlon-media-download",
    });

    if (!response.ok) {
      console.error(`[tlon-media] Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    // Determine content type and extension
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const ext = getExtensionFromContentType(contentType) || getExtensionFromUrl(url) || "bin";

    // Generate unique filename
    const filename = `${randomUUID()}.${ext}`;
    const localPath = path.join(mediaDir, filename);

    // Stream to file
    const body = response.body;
    if (!body) {
      console.error(`[tlon-media] No response body for ${url}`);
      return null;
    }

    const writeStream = createWriteStream(localPath);
    await pipeline(Readable.fromWeb(body as any), writeStream);

    return {
      localPath,
      contentType,
      originalUrl: url,
    };
  } catch (error: any) {
    console.error(`[tlon-media] Error downloading ${url}: ${error?.message ?? String(error)}`);
    return null;
  }
}

function getExtensionFromContentType(contentType: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
  };
  return map[contentType.split(";")[0].trim()] ?? null;
}

function getExtensionFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Download all images from a message and return attachment metadata.
 * Format matches OpenClaw's expected attachment structure.
 */
export async function downloadMessageImages(
  content: unknown,
  mediaDir?: string,
): Promise<Array<{ path: string; contentType: string }>> {
  const images = extractImageBlocks(content);
  if (images.length === 0) {
    return [];
  }

  const attachments: Array<{ path: string; contentType: string }> = [];

  for (const image of images) {
    const downloaded = await downloadMedia(image.url, mediaDir);
    if (downloaded) {
      attachments.push({
        path: downloaded.localPath,
        contentType: downloaded.contentType,
      });
    }
  }

  return attachments;
}
