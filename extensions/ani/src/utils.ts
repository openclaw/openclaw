import { getAniRuntime } from "./runtime.js";

/** Normalize an ANI server URL: trim, remove trailing slashes. */
export function normalizeAniServerUrl(url: string | undefined | null): string {
  return (url ?? "").replace(/\/+$/, "").trim();
}

/**
 * Shared MIME type mapping for common text file extensions.
 * Used by tools.ts (ani_send_file) and handler.ts (attachment processing).
 */
const MIME_MAP: Record<string, string> = {
  // Text
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".sql": "text/x-sql",
  ".sh": "text/x-shellscript",
  ".log": "text/plain",
  ".toml": "text/toml",
  ".ini": "text/plain",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
};

/** Get MIME type for a filename based on its extension. Falls back to "application/octet-stream" for binary. */
export function getMimeType(filename: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

/** Resolve ANI serverUrl and apiKey from config. Throws if not configured. */
export function resolveAniCredentials(): { serverUrl: string; apiKey: string } {
  const core = getAniRuntime();
  const cfg = core.config.loadConfig() as {
    channels?: { ani?: { serverUrl?: string; apiKey?: string } };
  };
  const serverUrl = normalizeAniServerUrl(cfg.channels?.ani?.serverUrl);
  const apiKey = cfg.channels?.ani?.apiKey ?? "";
  if (!serverUrl || !apiKey) {
    throw new Error("ANI: serverUrl and apiKey required");
  }
  return { serverUrl, apiKey };
}
