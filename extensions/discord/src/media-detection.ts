import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const DISCORD_VIDEO_MEDIA_EXTENSIONS = [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"];

function normalizeMediaPathForExtension(mediaUrl: string): string {
  const trimmed = mediaUrl.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    const fileName = parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1);
    // Mirror media-loader filename decoding without reinterpreting escapes in
    // earlier URL path segments, which are irrelevant to the file extension.
    try {
      return normalizeLowercaseStringOrEmpty(decodeURIComponent(fileName));
    } catch {
      return normalizeLowercaseStringOrEmpty(fileName);
    }
  } catch {
    const withoutSuffix = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
    return normalizeLowercaseStringOrEmpty(withoutSuffix);
  }
}

export function isLikelyDiscordVideoMedia(mediaUrl: string): boolean {
  const normalized = normalizeMediaPathForExtension(mediaUrl);
  return DISCORD_VIDEO_MEDIA_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}
