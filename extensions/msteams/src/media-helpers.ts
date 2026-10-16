import path from "node:path";
import {
  detectMime,
  extensionForMime,
  extractOriginalFilename,
  getFileExtension,
} from "../runtime-api.js";

// Teams supports up to 100 MiB through file-consent and SharePoint uploads.
export const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export async function getMimeType(url: string): Promise<string> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  const detected = await detectMime({ filePath: url });
  return detected ?? "application/octet-stream";
}

/**
 * Extract filename from URL or local path.
 * For local paths, extracts original filename if stored with embedded name pattern.
 * Falls back to deriving the extension from MIME type when no extension present.
 */
export async function extractFilename(url: string): Promise<string> {
  if (url.startsWith("data:")) {
    const mime = await getMimeType(url);
    const ext = extensionForMime(mime) ?? ".bin";
    const prefix = mime.startsWith("image/") ? "image" : "file";
    return `${prefix}${ext}`;
  }

  try {
    const pathname = new URL(url).pathname;
    let basename = path.basename(pathname);
    if (basename.includes("%")) {
      try {
        const decodedBasename = decodeURIComponent(basename);
        // Attachment names are display values; never turn escaped delimiters
        // into a different filesystem or URL path.
        if (
          !decodedBasename.includes("/") &&
          !decodedBasename.includes("\\") &&
          !decodedBasename.includes("\0")
        ) {
          basename = decodedBasename;
        }
      } catch {
        // Keep malformed percent escapes as the original literal filename.
      }
    }
    const existingExt = getFileExtension(basename);
    if (basename && existingExt) {
      return basename;
    }
    const mime = await getMimeType(url);
    const ext = extensionForMime(mime) ?? ".bin";
    const prefix = mime.startsWith("image/") ? "image" : "file";
    return basename ? `${basename}${ext}` : `${prefix}${ext}`;
  } catch {
    // Local paths - use extractOriginalFilename to extract embedded original name
    return extractOriginalFilename(url);
  }
}

export function isLocalPath(url: string): boolean {
  return (
    /^file:\/\//iu.test(url) ||
    url.startsWith("/") ||
    url.startsWith("~") ||
    url.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(url)
  );
}

export function extractMessageId(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("id" in response)) {
    return null;
  }
  const { id } = response;
  return typeof id === "string" && id ? id : null;
}
