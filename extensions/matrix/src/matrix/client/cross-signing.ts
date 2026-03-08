import crypto from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/matrix";

// Base58 alphabet used by Matrix recovery keys (standard Bitcoin alphabet)
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; // pragma: allowlist secret

/** Decode a base58 string to bytes. */
function base58Decode(input: string): Uint8Array {
  const alphabet = BASE58_ALPHABET;
  let result = BigInt(0);
  for (const char of input) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`Invalid base58 character: ${char}`);
    result = result * BigInt(58) + BigInt(index);
  }
  // Convert BigInt to bytes
  const hex = result.toString(16);
  const padded = hex.length % 2 === 0 ? hex : "0" + hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  // Account for leading '1's in base58 (each '1' = 0x00 byte)
  let leadingZeros = 0;
  for (const char of input) {
    if (char === "1") leadingZeros++;
    else break;
  }
  if (leadingZeros === 0) return bytes;
  const result2 = new Uint8Array(leadingZeros + bytes.length);
  result2.set(bytes, leadingZeros);
  return result2;
}

/**
 * Decode a Matrix recovery key (base58 + 2-byte prefix 0x8B,0x01 + 32-byte key + XOR parity).
 * Returns the raw 32-byte key material.
 */
export function decodeRecoveryKey(recoveryKey: string): Uint8Array {
  // Strip spaces and dashes (visual separators)
  const cleaned = recoveryKey.replace(/[\s-]/g, "");
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(cleaned);
  } catch (err) {
    throw new Error(
      `Recovery key base58 decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (bytes.length !== 35) {
    throw new Error(`Recovery key has wrong length: expected 35 bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== 0x8b || bytes[1] !== 0x01) {
    throw new Error("Recovery key has wrong prefix: expected 0x8B 0x01");
  }
  // Verify XOR parity
  let parity = 0;
  for (let i = 0; i < 34; i++) parity ^= bytes[i];
  if (parity !== bytes[34]) {
    throw new Error("Recovery key checksum mismatch — key may be mistyped");
  }
  return bytes.slice(2, 34);
}

/**
 * Derive AES and HMAC keys from a raw 32-byte SSSS key using HKDF-SHA256.
 * Per Matrix spec: salt = 32 zero bytes, info = utf8(name), output = 64 bytes.
 */
function deriveKeyMaterial(rawKey: Uint8Array, info: string): { aesKey: Buffer; hmacKey: Buffer } {
  const salt = Buffer.alloc(32, 0);
  const infoBuffer = Buffer.from(info, "utf8");
  const derived = crypto.hkdfSync("sha256", rawKey, salt, infoBuffer, 64) as ArrayBuffer;
  const keyBuf = Buffer.from(derived);
  return {
    aesKey: keyBuf.subarray(0, 32),
    hmacKey: keyBuf.subarray(32, 64),
  };
}

type SSSSEncryptedSecret = {
  encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }>;
};

/**
 * Decrypt a Matrix SSSS secret (m.secret_storage.v1.aes-hmac-sha2).
 * Returns the plaintext as a UTF-8 string.
 */
export function decryptSSSSSecret(
  secretData: SSSSEncryptedSecret,
  rawKey: Uint8Array,
  secretName: string,
  keyId: string,
): string {
  const entry = secretData.encrypted?.[keyId];
  if (!entry) {
    throw new Error(`Secret "${secretName}" has no entry for key ID "${keyId}"`);
  }
  const { aesKey, hmacKey } = deriveKeyMaterial(rawKey, secretName);

  const iv = Buffer.from(entry.iv, "base64");
  const ciphertext = Buffer.from(entry.ciphertext, "base64");
  const storedMac = entry.mac.replace(/=+$/, "");

  // Verify MAC (HMAC-SHA256 of ciphertext only, per matrix-js-sdk behaviour)
  const computedMac = crypto
    .createHmac("sha256", hmacKey)
    .update(ciphertext)
    .digest("base64")
    .replace(/=+$/, "");
  if (computedMac !== storedMac) {
    throw new Error(
      `MAC verification failed for secret "${secretName}" — wrong recovery key or corrupted secret`,
    );
  }

  // Decrypt AES-256-CTR
  const decipher = crypto.createDecipheriv("aes-256-ctr", aesKey, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Canonical JSON for Matrix: keys sorted lexicographically, no whitespace. */
function canonicalJson(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

/** Ed25519 PKCS#8 DER header — prepend to a 32-byte seed to get a valid DER key. */
const ED25519_PKCS8_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/** Create a Node.js KeyObject from a 32-byte Ed25519 seed via PKCS#8 DER encoding. */
function privateKeyFromSeed(seed: Uint8Array): crypto.KeyObject {
  if (seed.length !== 32) throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  const pkcs8 = Buffer.concat([ED25519_PKCS8_HEADER, Buffer.from(seed)]);
  return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

/** Extract raw 32-byte Ed25519 public key from an Ed25519 private KeyObject. */
function publicKeyBytes(privKey: crypto.KeyObject): Buffer {
  const pub = crypto.createPublicKey(privKey);
  // Ed25519 SPKI DER: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes pubkey>
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

/** Authenticated GET request to the Matrix homeserver, returning parsed JSON. */
async function matrixGet<T>(params: {
  homeserver: string;
  accessToken: string;
  path: string;
  auditContext: string;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.homeserver}${params.path}`,
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${params.accessToken}` },
    },
    auditContext: params.auditContext,
  });
  try {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Matrix HTTP ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

/** Authenticated POST request to the Matrix homeserver, returning parsed JSON. */
async function matrixPost<T>(params: {
  homeserver: string;
  accessToken: string;
  path: string;
  body: unknown;
  auditContext: string;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.homeserver}${params.path}`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
    },
    auditContext: params.auditContext,
  });
  try {
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Matrix HTTP ${response.status}: ${body}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

type DeviceKeys = {
  algorithms: string[];
  device_id: string;
  keys: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
  unsigned?: Record<string, unknown>;
  user_id: string;
};

/**
 * Attempt to bootstrap cross-signing by signing the bot's own device key with the
 * self-signing key loaded from Matrix secret storage (SSSS) via the provided recovery key.
 *
 * Runs at gateway startup when `encryption: true` and `recoveryKey` are both configured.
 * Fails gracefully: logs warnings on any error and never throws.
 */
export async function bootstrapCrossSigningFromRecoveryKey(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  recoveryKey: string;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<void> {
  const { homeserver, userId, accessToken, logger } = params;
  const http = { homeserver, accessToken };

  let rawKey: Uint8Array;
  try {
    rawKey = decodeRecoveryKey(params.recoveryKey);
  } catch (err) {
    logger.warn("matrix: cross-signing bootstrap skipped — could not decode recovery key", {
      error: String(err),
    });
    return;
  }

  try {
    // 1. Fetch the encrypted self-signing key secret from SSSS first so we can extract
    //    the keyId from it when m.secret_storage.default is absent (partial SSSS setups).
    const sskEncrypted = await matrixGet<SSSSEncryptedSecret>({
      ...http,
      path: `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.cross_signing.self_signing`,
      auditContext: "matrix.ssss.selfSigningKey",
    });

    // 2. Resolve the SSSS key ID: prefer m.secret_storage.default, fall back to the
    //    first key present in the encrypted secret itself.
    let keyId: string;
    try {
      const defaultKeyData = await matrixGet<{ key: string }>({
        ...http,
        path: `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.secret_storage.default`,
        auditContext: "matrix.ssss.defaultKey",
      });
      if (!defaultKeyData.key) throw new Error("m.secret_storage.default has no 'key' field");
      keyId = defaultKeyData.key;
    } catch (err) {
      // Only fall back to extracting keyId from the secret if the account data is truly absent
      // (HTTP 404). Propagate network errors, 5xx, etc. so they aren't silently hidden.
      if (!(err instanceof Error && /HTTP 404/.test(err.message))) throw err;
      const keys = Object.keys(sskEncrypted.encrypted ?? {});
      if (keys.length === 0)
        throw new Error("No encrypted entries found in m.cross_signing.self_signing");
      keyId = keys[0];
    }

    // 3. Decrypt the self-signing key seed
    const sskSeedBase64 = decryptSSSSSecret(
      sskEncrypted,
      rawKey,
      "m.cross_signing.self_signing",
      keyId,
    );
    const sskSeed = Buffer.from(sskSeedBase64, "base64");

    // 4. Import SSK as an Ed25519 private key and derive its public key
    const sskPrivKey = privateKeyFromSeed(sskSeed);
    const sskPubKeyBase64 = publicKeyBytes(sskPrivKey).toString("base64").replace(/=+$/, "");

    // 5. Discover our current device ID via whoami
    const whoami = await matrixGet<{ user_id: string; device_id: string }>({
      ...http,
      path: "/_matrix/client/v3/account/whoami",
      auditContext: "matrix.whoami",
    });
    const deviceId = whoami.device_id;
    if (!deviceId) throw new Error("whoami response missing device_id");

    // 6. Fetch our own device key from the homeserver
    const keysResult = await matrixPost<{
      device_keys: Record<string, Record<string, DeviceKeys>>;
    }>({
      ...http,
      path: "/_matrix/client/v3/keys/query",
      body: { device_keys: { [userId]: [deviceId] } },
      auditContext: "matrix.keys.query",
    });
    const deviceKey = keysResult.device_keys?.[userId]?.[deviceId];
    if (!deviceKey) throw new Error(`Could not find own device key for ${userId}/${deviceId}`);

    // 7. Skip if the device already bears a signature from this SSK
    const sskSigKey = `ed25519:${sskPubKeyBase64}`;
    if (deviceKey.signatures?.[userId]?.[sskSigKey]) {
      logger.info(`matrix: device ${deviceId} is already cross-signed — skipping bootstrap`);
      return;
    }

    // 8. Sign the canonical device key object (without existing signatures)
    const { signatures: _omit, unsigned: _unsigned, ...deviceKeyWithoutSigs } = deviceKey;
    const signature = crypto.sign(
      null,
      Buffer.from(canonicalJson(deviceKeyWithoutSigs)),
      sskPrivKey,
    );

    // 9. Upload the signature to the homeserver
    await matrixPost<unknown>({
      ...http,
      path: "/_matrix/client/v3/keys/signatures/upload",
      auditContext: "matrix.keys.signatures.upload",
      body: {
        [userId]: {
          [deviceId]: {
            ...deviceKeyWithoutSigs,
            signatures: {
              ...(deviceKey.signatures ?? {}),
              [userId]: {
                ...(deviceKey.signatures?.[userId] ?? {}),
                [sskSigKey]: signature.toString("base64").replace(/=+$/, ""),
              },
            },
          },
        },
      },
    });

    logger.info(`matrix: device ${deviceId} successfully cross-signed via recovery key`);
  } catch (err) {
    logger.warn("matrix: cross-signing bootstrap failed (non-fatal)", {
      error: String(err),
    });
  }
}
