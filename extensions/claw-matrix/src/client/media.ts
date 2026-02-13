/**
 * Matrix media handling with AES-256-CTR encryption for E2E rooms.
 *
 * OlmMachine handles key exchange (Olm/Megolm) but NOT file payload encryption.
 * File encryption uses manual AES-256-CTR per Matrix spec (Client-Server API §11.12.5).
 */

import * as crypto from "node:crypto";
import { matrixFetch, getClient } from "./http.js";

export interface EncryptedFile {
  url: string;
  key: {
    kty: "oct";
    key_ops: string[];
    alg: "A256CTR";
    k: string; // base64url
    ext: true;
  };
  iv: string; // base64(iv + 8 zero bytes)
  hashes: { sha256: string };
  v: "v2";
}

interface UploadResult {
  mxcUrl: string;
  encryptedFile?: EncryptedFile;
}

// ── Encryption Helpers ────────────────────────────────────────────────

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64Url(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

function toUnpaddedBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}

function fromUnpaddedBase64(str: string): Buffer {
  // Add padding back for Buffer.from
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Encrypt a file buffer for an encrypted Matrix room.
 * Returns the ciphertext and the EncryptedFile metadata.
 */
function encryptAttachment(plaintext: Buffer): {
  ciphertext: Buffer;
  file: Omit<EncryptedFile, "url">;
} {
  // Generate random AES-256 key and IV
  const key = crypto.randomBytes(32);
  // Matrix spec: IV is 16 bytes, but only first 8 are random (rest zeroed)
  const ivBytes = Buffer.alloc(16);
  crypto.randomBytes(8).copy(ivBytes, 0);

  // Encrypt with AES-256-CTR
  const cipher = crypto.createCipheriv("aes-256-ctr", key, ivBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // SHA-256 of ciphertext
  const hash = crypto.createHash("sha256").update(ciphertext).digest();

  return {
    ciphertext,
    file: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: toBase64Url(key),
        ext: true,
      },
      iv: toUnpaddedBase64(ivBytes),
      hashes: { sha256: toUnpaddedBase64(hash) },
      v: "v2",
    },
  };
}

/**
 * Decrypt an encrypted Matrix attachment.
 * Validates SHA-256 hash BEFORE decryption (prevents malleability attacks).
 */
export function decryptAttachment(ciphertext: Buffer, file: EncryptedFile): Buffer {
  // Validate algorithm
  if (file.key.alg !== "A256CTR") {
    throw new Error(`Unsupported encryption algorithm: ${file.key.alg}`);
  }

  // Validate SHA-256 hash of ciphertext FIRST
  const expectedHash = fromUnpaddedBase64(file.hashes.sha256);
  const actualHash = crypto.createHash("sha256").update(ciphertext).digest();
  if (!actualHash.equals(expectedHash)) {
    throw new Error("Encrypted file hash mismatch — data may be tampered");
  }

  // Decrypt
  const key = fromBase64Url(file.key.k);
  const iv = fromUnpaddedBase64(file.iv);
  const decipher = crypto.createDecipheriv("aes-256-ctr", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── Upload/Download ───────────────────────────────────────────────────

/**
 * Upload media to the homeserver.
 * If encrypted=true, encrypts the buffer before upload.
 */
export async function uploadMedia(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  encrypted: boolean,
): Promise<UploadResult> {
  let uploadBuffer = buffer;
  let uploadMime = mimeType;
  let encryptedFile: EncryptedFile | undefined;

  if (encrypted) {
    const result = encryptAttachment(buffer);
    uploadBuffer = result.ciphertext;
    uploadMime = "application/octet-stream"; // Encrypted files always upload as octet-stream
    encryptedFile = { ...result.file, url: "" }; // URL filled after upload
  }

  const client = getClient();
  const url = `${client.homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.accessToken}`,
        "Content-Type": uploadMime,
      },
      body: new Uint8Array(uploadBuffer),
      signal: controller.signal,
    });

    const json = (await response.json()) as {
      content_uri?: string;
      errcode?: string;
      error?: string;
    };
    if (!response.ok || !json.content_uri) {
      throw new Error(
        `Upload failed: ${json.errcode ?? "unknown"} — ${json.error ?? response.statusText}`,
      );
    }

    const mxcUrl = json.content_uri;
    if (encryptedFile) encryptedFile.url = mxcUrl;

    return { mxcUrl, encryptedFile };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download media from the homeserver.
 * Uses authenticated media endpoint (v1.11+).
 */
export async function downloadMedia(mxcUrl: string, maxSize: number = 52_428_800): Promise<Buffer> {
  if (!isValidMxcUrl(mxcUrl)) {
    throw new Error(`Invalid mxc URL: ${mxcUrl}`);
  }

  // Parse mxc://server/mediaId
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid mxc URL: ${mxcUrl}`);

  const [, serverName, mediaId] = match;

  const client = getClient();
  const url = `${client.homeserver}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${client.accessToken}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const arrayBuf = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    if (buf.length > maxSize) {
      throw new Error(`File too large: ${buf.length} bytes (max ${maxSize})`);
    }

    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download and optionally decrypt media.
 */
export async function downloadAndDecryptMedia(
  mxcUrl: string,
  encryptedFile?: EncryptedFile,
  maxSize?: number,
): Promise<Buffer> {
  const ciphertext = await downloadMedia(mxcUrl, maxSize);

  if (encryptedFile) {
    return decryptAttachment(ciphertext, encryptedFile);
  }

  return ciphertext;
}

// ── MIME → msgtype mapping ────────────────────────────────────────────
export function mimeToMsgtype(mime: string): string {
  if (mime.startsWith("image/")) return "m.image";
  if (mime.startsWith("audio/")) return "m.audio";
  if (mime.startsWith("video/")) return "m.video";
  return "m.file";
}

/**
 * Validate mxc:// URI format.
 */
export function isValidMxcUrl(url: string): boolean {
  return /^mxc:\/\/[a-zA-Z0-9._:-]+\/[a-zA-Z0-9._-]+$/.test(url);
}
