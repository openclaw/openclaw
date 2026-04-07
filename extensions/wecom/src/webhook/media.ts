/**
 * Webhook inbound media processing
 *
 * Migrated from @mocrane/wecom media.ts (inbound decryption only).
 * Responsibilities: AES-CBC decryption of WeCom encrypted media files, MIME type detection.
 */

import crypto from "node:crypto";
import { pkcs7Unpad, decodeEncodingAESKey } from "@wecom/aibot-node-sdk";
import { wecomFetch, readResponseBodyAsBuffer, type WecomHttpOptions } from "./http.js";

// ============================================================================
// Media file decryption
// ============================================================================

/** WeCom uses 32-byte PKCS#7 block size (not AES's 16-byte block) */
export const WECOM_PKCS7_BLOCK_SIZE = 32;

/** Decrypted media file and source info (aligned with original DecryptedWecomMedia) */
export type DecryptedWecomMedia = {
  buffer: Buffer;
  /** HTTP Content-Type (normalized) */
  sourceContentType?: string;
  /** Filename extracted from Content-Disposition */
  sourceFilename?: string;
  /** Final request URL (after following redirects) */
  sourceUrl?: string;
};

/**
 * **decryptWecomMediaWithMeta (decrypt WeCom media and return source info)**
 *
 * Returns decrypted result while preserving metadata from the download response (content-type / filename / final url),
 * enabling the caller to more accurately infer file extension and MIME.
 */
export async function decryptWecomMediaWithMeta(
  url: string,
  encodingAESKey: string,
  params?: { maxBytes?: number; http?: WecomHttpOptions },
): Promise<DecryptedWecomMedia> {
  // 1. Download encrypted content
  const res = await wecomFetch(url, undefined, {
    ...params?.http,
    timeoutMs: params?.http?.timeoutMs ?? 15_000,
  });
  if (!res.ok) {
    throw new Error(`failed to download media: ${res.status}`);
  }
  const sourceContentType = normalizeMime(res.headers.get("content-type"));
  const sourceFilename = extractFilenameFromContentDisposition(
    res.headers.get("content-disposition"),
  );
  const sourceUrl = res.url || url;
  const encryptedData = await readResponseBodyAsBuffer(res, params?.maxBytes);

  // 2. Prepare Key and IV
  const aesKey = decodeEncodingAESKey(encodingAESKey);
  const iv = aesKey.subarray(0, 16);

  // 3. Decrypt
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const decryptedPadded = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  // 4. Unpad
  // Note: Unlike msg bodies, usually removing PKCS#7 padding is enough for media files.
  // The Python SDK logic: pad_len = decrypted_data[-1]; decrypted_data = decrypted_data[:-pad_len]
  // Our pkcs7Unpad function does exactly this + validation.
  return {
    buffer: pkcs7Unpad(decryptedPadded, WECOM_PKCS7_BLOCK_SIZE),
    sourceContentType,
    sourceFilename,
    sourceUrl,
  };
}

// ============================================================================
// HTTP header parsing (used by decryptWecomMediaWithMeta)
// ============================================================================

/** Normalize MIME type */
function normalizeMime(contentType?: string | null): string | undefined {
  const raw = String(contentType ?? "").trim();
  if (!raw) {
    return undefined;
  }
  return raw.split(";")[0]?.trim().toLowerCase() || undefined;
}

/** Extract filename from Content-Disposition */
function extractFilenameFromContentDisposition(disposition?: string | null): string | undefined {
  const raw = String(disposition ?? "").trim();
  if (!raw) {
    return undefined;
  }

  // Prefer filename* (RFC 5987 encoding)
  const star = raw.match(/filename\*\s*=\s*([^;]+)/i);
  if (star?.[1]) {
    const v = star[1]
      .trim()
      .replace(/^UTF-8''/i, "")
      .replace(/^"(.*)"$/, "$1");
    try {
      const decoded = decodeURIComponent(v);
      if (decoded.trim()) {
        return decoded.trim();
      }
    } catch {
      /* ignore */
    }
    if (v.trim()) {
      return v.trim();
    }
  }

  // Then try filename
  const plain = raw.match(/filename\s*=\s*([^;]+)/i);
  if (plain?.[1]) {
    const v = plain[1]
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    if (v) {
      return v;
    }
  }
  return undefined;
}
