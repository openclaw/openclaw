/**
 * Device self-signing with ed25519 cross-signing keys.
 *
 * After SSSS restore gives us the self-signing key (SSK) seed, this module
 * signs the bot's device keys with the SSK and uploads the signature to the
 * homeserver — making the device "verified" under the user's cross-signing
 * identity without interactive verification.
 *
 * Crypto: Ed25519 via Node.js PKCS8 DER key import.
 */

import * as crypto from "node:crypto";
import type { PluginLogger } from "../openclaw-types.js";
import { matrixFetch } from "../client/http.js";
import { createLogger } from "../util/logger.js";

// ── Canonical JSON ──────────────────────────────────────────────────────

/**
 * Matrix canonical JSON encoding.
 *
 * Spec: recursively sort object keys lexicographically, no whitespace,
 * no trailing commas. Strips top-level `signatures` and `unsigned` keys
 * before encoding (they must not be included in the signed payload).
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(stripForSigning(obj)));
}

function stripForSigning(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "signatures" || k === "unsigned") continue;
    result[k] = v;
  }
  return result;
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ── Ed25519 Helpers ─────────────────────────────────────────────────────

/** Unpadded base64 encoding (Matrix convention). */
function unpaddedBase64(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}

/**
 * Ed25519 PKCS8 DER prefix (16 bytes).
 * The full PKCS8 key is this prefix followed by the 32-byte seed.
 * Using DER import instead of JWK because Node.js >=25 requires
 * the `x` (public key) field in Ed25519 JWK even for private-only import.
 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Create a Node.js Ed25519 private key object from a 32-byte seed. */
function ed25519PrivateKeyFromSeed(seed: Buffer): crypto.KeyObject {
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
}

/**
 * Derive the unpadded-base64 ed25519 public key from a 32-byte seed.
 */
export function deriveEd25519PublicKey(seed: Buffer): string {
  const privateKey = ed25519PrivateKeyFromSeed(seed);
  const publicKey = crypto.createPublicKey(privateKey);
  const rawPub = publicKey.export({ type: "spki", format: "der" });
  // DER-encoded Ed25519 SPKI is 44 bytes: 12-byte header + 32-byte key
  return unpaddedBase64(Buffer.from(rawPub.subarray(rawPub.length - 32)));
}

// ── Self-Sign Device ────────────────────────────────────────────────────

export interface SelfSignOpts {
  userId: string;
  deviceId: string;
  sskSeed: Buffer;
  sskPublicKeyId: string;
  deviceEd25519Key: string;
  deviceCurve25519Key: string;
  log?: PluginLogger;
}

/**
 * Sign the bot's own device key with the self-signing key and upload
 * the signature to the homeserver.
 *
 * This makes the device "verified" under cross-signing without needing
 * interactive emoji verification.
 */
export async function selfSignDevice(opts: SelfSignOpts): Promise<void> {
  const { userId, deviceId, sskSeed, sskPublicKeyId, deviceEd25519Key, deviceCurve25519Key, log } =
    opts;
  const slog = createLogger("matrix", log);

  // 1. Build device key object
  const deviceKeyObj: Record<string, unknown> = {
    user_id: userId,
    device_id: deviceId,
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    keys: {
      [`ed25519:${deviceId}`]: deviceEd25519Key,
      [`curve25519:${deviceId}`]: deviceCurve25519Key,
    },
  };

  // 2. Canonical JSON encode (strips signatures + unsigned)
  const canonicalJsonStr = canonicalJson(deviceKeyObj);

  // 3. Ed25519 sign with SSK seed
  const privateKey = ed25519PrivateKeyFromSeed(sskSeed);
  const signature = crypto.sign(null, Buffer.from(canonicalJsonStr), privateKey);
  const base64Signature = unpaddedBase64(Buffer.from(signature));

  slog.info("Signed device key with self-signing key", {
    deviceId,
    sskKeyId: sskPublicKeyId,
  });

  // 4. Upload signature
  const uploadPayload = {
    [userId]: {
      [deviceId]: {
        ...deviceKeyObj,
        signatures: {
          [userId]: {
            [`ed25519:${sskPublicKeyId}`]: base64Signature,
          },
        },
      },
    },
  };

  try {
    await matrixFetch("POST", "/_matrix/client/v3/keys/signatures/upload", uploadPayload);
    slog.info("Uploaded self-signing signature", { deviceId });
  } catch (err: any) {
    slog.error("Failed to upload self-signing signature", {
      error: err.message,
      deviceId,
    });
    throw err;
  }
}
