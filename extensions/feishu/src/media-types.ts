import path from "node:path";

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi"]);
export const AUDIO_EXTENSIONS = new Set([".opus", ".ogg", ".mp3", ".wav"]);

/**
 * Resolve media content type from a file extension or URL.
 * Accepts either a bare extension (e.g. ".png") or a full URL/path
 * from which the extension will be extracted.
 */
export function resolveMediaContentType(extOrUrl: string): string {
  const ext = extOrUrl.startsWith(".")
    ? extOrUrl.toLowerCase()
    : path.extname(extOrUrl).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "file";
}
