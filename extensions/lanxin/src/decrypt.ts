import crypto from "node:crypto";
import type { LanxinWebhookDecryptedPayload } from "./types.js";

function decodeLanxinAesKey(aesKey: string): Buffer {
  const decodedText = Buffer.from(`${aesKey}=`, "base64").toString("utf8");
  return Buffer.from(decodedText, "utf8");
}

function resolveAesCbcAlgorithm(key: Buffer): "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc" {
  if (key.length === 16) return "aes-128-cbc";
  if (key.length === 24) return "aes-192-cbc";
  if (key.length === 32) return "aes-256-cbc";
  throw new Error(`Unsupported Lanxin AES key length: ${key.length}`);
}

export function decryptLanxinDataEncrypt(params: {
  dataEncrypt: string;
  aesKey: string;
}): LanxinWebhookDecryptedPayload {
  const key = decodeLanxinAesKey(params.aesKey.trim());
  const algorithm = resolveAesCbcAlgorithm(key);
  const iv = key.subarray(0, 16);
  const encrypted = Buffer.from(params.dataEncrypt.trim(), "base64");
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  const payload = JSON.parse(plaintext) as LanxinWebhookDecryptedPayload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Lanxin decrypted payload is not an object");
  }
  return payload;
}
