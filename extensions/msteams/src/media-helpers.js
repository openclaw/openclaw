import path from "node:path";
import {
  detectMime,
  extensionForMime,
  extractOriginalFilename,
  getFileExtension
} from "openclaw/plugin-sdk/msteams";
async function getMimeType(url) {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  const detected = await detectMime({ filePath: url });
  return detected ?? "application/octet-stream";
}
async function extractFilename(url) {
  if (url.startsWith("data:")) {
    const mime = await getMimeType(url);
    const ext = extensionForMime(mime) ?? ".bin";
    const prefix = mime.startsWith("image/") ? "image" : "file";
    return `${prefix}${ext}`;
  }
  try {
    const pathname = new URL(url).pathname;
    const basename = path.basename(pathname);
    const existingExt = getFileExtension(pathname);
    if (basename && existingExt) {
      return basename;
    }
    const mime = await getMimeType(url);
    const ext = extensionForMime(mime) ?? ".bin";
    const prefix = mime.startsWith("image/") ? "image" : "file";
    return basename ? `${basename}${ext}` : `${prefix}${ext}`;
  } catch {
    return extractOriginalFilename(url);
  }
}
function isLocalPath(url) {
  if (url.startsWith("file://") || url.startsWith("/") || url.startsWith("~")) {
    return true;
  }
  if (url.startsWith("\\") && !url.startsWith("\\\\")) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(url)) {
    return true;
  }
  if (url.startsWith("\\\\")) {
    return true;
  }
  return false;
}
function extractMessageId(response) {
  if (!response || typeof response !== "object") {
    return null;
  }
  if (!("id" in response)) {
    return null;
  }
  const { id } = response;
  if (typeof id !== "string" || !id) {
    return null;
  }
  return id;
}
export {
  extractFilename,
  extractMessageId,
  getMimeType,
  isLocalPath
};
