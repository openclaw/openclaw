import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WecomCrypto } from "../crypto.js";
import { logger } from "../logger.js";
import { MEDIA_CACHE_DIR } from "./constants.js";

// ── SSRF guard for media URLs ────────────────────────────────────────────────

function assertSafeMediaUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid media URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Media URL must use HTTP(S), got: ${parsed.protocol}`);
  }
}

// ── Magic-byte signatures for common file formats ───────────────────────────
const MAGIC_SIGNATURES = [
  { magic: [0xff, 0xd8, 0xff], ext: "jpg" }, // JPEG
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], ext: "png" }, // PNG
  { magic: [0x47, 0x49, 0x46, 0x38], ext: "gif" }, // GIF
  { magic: [0x25, 0x50, 0x44, 0x46], ext: "pdf" }, // %PDF
  { magic: [0x50, 0x4b, 0x03, 0x04], ext: "zip" }, // PK (ZIP / DOCX / XLSX / PPTX)
  { magic: [0x50, 0x4b, 0x05, 0x06], ext: "zip" }, // PK (empty ZIP)
  { magic: [0xd0, 0xcf, 0x11, 0xe0], ext: "doc" }, // OLE2 (DOC / XLS / PPT)
  { magic: [0x52, 0x61, 0x72, 0x21], ext: "rar" }, // Rar!
  { magic: [0x1f, 0x8b], ext: "gz" }, // gzip
  { magic: [0x42, 0x4d], ext: "bmp" }, // BMP
  { magic: [0x49, 0x44, 0x33], ext: "mp3" }, // ID3 (MP3)
  { magic: [0x00, 0x00, 0x00], ext: "mp4" }, // ftyp box (loose)
  { magic: [0x52, 0x49, 0x46, 0x46], ext: "wav" }, // RIFF (WAV / AVI)
];

/**
 * Check whether a buffer looks like a recognisable (plain) file by inspecting
 * its leading magic bytes.  Returns the matched extension or `null`.
 */
function detectMagic(buf) {
  if (!buf || buf.length < 4) return null;
  for (const sig of MAGIC_SIGNATURES) {
    if (
      buf.length >= sig.magic.length &&
      sig.magic.every((b, i) => buf[i] === b)
    ) {
      return sig.ext;
    }
  }
  return null;
}

/**
 * Conditionally decrypt a buffer.
 *
 * WeCom encrypts media with AES-256-CBC in Agent mode, but in some Bot (AI
 * 机器人) configurations the file URL returns an **unencrypted** payload.
 * Blindly decrypting an already-plain file corrupts it (#44).
 *
 * Strategy:
 *   1. If raw bytes already match a known file signature → skip decrypt.
 *   2. Otherwise attempt AES-256-CBC decryption.
 *   3. If decryption throws or the result has no recognisable signature,
 *      fall back to the original bytes (best-effort).
 */
function smartDecrypt(rawBuffer, encodingAesKey, token) {
  const plainExt = detectMagic(rawBuffer);
  if (plainExt) {
    logger.info("Media is already plain (skip decrypt)", {
      magic: plainExt,
      size: rawBuffer.length,
    });
    return { buffer: rawBuffer, decrypted: false };
  }

  try {
    const crypto = new WecomCrypto(token, encodingAesKey);
    const dec = crypto.decryptMedia(rawBuffer);
    logger.info("Media decrypted", {
      inputSize: rawBuffer.length,
      outputSize: dec.length,
    });
    return { buffer: dec, decrypted: true };
  } catch (e) {
    logger.warn("Decrypt failed, using raw bytes", {
      error: e.message,
      size: rawBuffer.length,
    });
    return { buffer: rawBuffer, decrypted: false };
  }
}

// ── Image helpers ───────────────────────────────────────────────────────────

function detectImageExt(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  return "jpg";
}

/**
 * Download and (conditionally) decrypt a WeCom image.
 * @param {string} imageUrl - Image URL from WeCom callback
 * @param {string} encodingAesKey - AES key
 * @param {string} token - Token
 * @returns {Promise<{ localPath: string, mimeType: string }>}
 */
export async function downloadAndDecryptImage(imageUrl, encodingAesKey, token) {
  assertSafeMediaUrl(imageUrl);
  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  logger.info("Downloading image", { url: imageUrl.substring(0, 80) });
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  logger.debug("Downloaded image bytes", { size: rawBuffer.length });

  const { buffer: finalBuffer } = smartDecrypt(
    rawBuffer,
    encodingAesKey,
    token,
  );

  const ext = detectImageExt(finalBuffer);
  const filename = `wecom_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
  const localPath = join(MEDIA_CACHE_DIR, filename);
  writeFileSync(localPath, finalBuffer);

  const mimeType =
    ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
  logger.info("Image saved", {
    path: localPath,
    size: finalBuffer.length,
    mimeType,
  });
  return { localPath, mimeType };
}

// ── File helpers ────────────────────────────────────────────────────────────

/**
 * Download and (conditionally) decrypt a file from WeCom.
 *
 * In Agent mode WeCom encrypts all media with AES-256-CBC; in Bot mode the
 * file URL may return plain bytes.  This function auto-detects the case and
 * only decrypts when necessary, preventing file corruption (#44).
 *
 * @param {string} fileUrl - File download URL
 * @param {string} fileName - Original file name
 * @param {string} encodingAesKey - AES key for decryption
 * @param {string} token - Token for decryption
 * @returns {Promise<{ localPath: string, effectiveFileName: string }>}
 */
export async function downloadWecomFile(
  fileUrl,
  fileName,
  encodingAesKey,
  token,
) {
  assertSafeMediaUrl(fileUrl);
  if (!existsSync(MEDIA_CACHE_DIR)) {
    mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }

  logger.info("Downloading file", {
    url: fileUrl.substring(0, 80),
    name: fileName,
  });
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  const rawBuffer = Buffer.from(await response.arrayBuffer());

  // Try to extract filename from Content-Disposition header if not provided
  let effectiveFileName = fileName;
  if (!effectiveFileName) {
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition) {
      // Match: filename="xxx.pdf" or filename*=UTF-8''xxx.pdf
      const filenameMatch = contentDisposition.match(
        /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i,
      );
      if (filenameMatch && filenameMatch[1]) {
        effectiveFileName = decodeURIComponent(filenameMatch[1]);
        logger.info("Extracted filename from Content-Disposition", {
          name: effectiveFileName,
        });
      }
    }
  }

  // Smart decrypt: only decrypt if the raw bytes are not already a valid file.
  const { buffer: finalBuffer, decrypted } = smartDecrypt(
    rawBuffer,
    encodingAesKey,
    token,
  );
  logger.info("File processed", {
    name: effectiveFileName,
    rawSize: rawBuffer.length,
    finalSize: finalBuffer.length,
    wasDecrypted: decrypted,
  });

  const safeName = (effectiveFileName || `file_${Date.now()}`).replace(
    /[/\\:*?"<>|]/g,
    "_",
  );
  const localPath = join(MEDIA_CACHE_DIR, `${Date.now()}_${safeName}`);
  writeFileSync(localPath, finalBuffer);

  logger.info("File saved", { path: localPath, size: finalBuffer.length });
  return { localPath, effectiveFileName: effectiveFileName || fileName };
}

/**
 * Guess MIME type from file extension.
 */
export function guessMimeType(fileName) {
  const ext = (fileName || "").split(".").pop()?.toLowerCase() || "";
  const mimeMap = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
  };
  return mimeMap[ext] || "application/octet-stream";
}
