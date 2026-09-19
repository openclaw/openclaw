// Feishu plugin module recognizes a local image path that arrived as plain text.
import path from "node:path";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) {
    return null;
  }

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) {
    return null;
  }

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
  const isImageExt = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".heic",
    ".tif",
    ".tiff",
  ].includes(ext);
  if (!isImageExt) {
    return null;
  }

  if (!path.isAbsolute(raw)) {
    return null;
  }
  try {
    const stat = statRegularFileSync(raw);
    if (stat.missing) {
      return null;
    }
  } catch {
    return null;
  }

  return raw;
}
