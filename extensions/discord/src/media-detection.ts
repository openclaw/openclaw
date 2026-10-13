import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const DISCORD_VIDEO_MEDIA_EXTENSIONS = [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"];

export function isLikelyDiscordVideoMedia(mediaUrl: string): boolean {
  const trimmed = mediaUrl.trim();
  if (!trimmed) {
    return false;
  }
  let path: string;
  try {
    const { pathname } = new URL(trimmed);
    path = pathname.slice(pathname.lastIndexOf("/") + 1);
    // Decode only the filename; malformed escapes in earlier path segments are irrelevant.
    try {
      path = decodeURIComponent(path);
    } catch {}
  } catch {
    path = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  }
  const normalized = normalizeLowercaseStringOrEmpty(path);
  return DISCORD_VIDEO_MEDIA_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}
