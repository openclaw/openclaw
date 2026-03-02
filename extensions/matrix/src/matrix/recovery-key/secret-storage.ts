import crypto from "node:crypto";
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { ACCOUNT_DATA_TYPES, SECRET_STORAGE_ALGORITHM } from "./constants.js";
import type { CrossSigningKeys, EncryptedSecret, SecretStorageKeyInfo } from "./types.js";

/**
 * Fetch the default secret storage key ID and its metadata from account data.
 */
export async function fetchSecretStorageMetadata(client: MatrixClient): Promise<{
  keyId: string;
  keyInfo: SecretStorageKeyInfo;
}> {
  // eslint-disable-next-line -- bot-sdk account data accessor is untyped
  const defaultKeyEvent = await (client as any).getAccountData(ACCOUNT_DATA_TYPES.defaultKey);
  const keyId: string | undefined = defaultKeyEvent?.key;
  if (!keyId) {
    throw new Error("No default secret storage key found");
  }

  // eslint-disable-next-line -- bot-sdk account data accessor is untyped
  const keyInfo = (await (client as any).getAccountData(
    `m.secret_storage.key.${keyId}`,
  )) as SecretStorageKeyInfo;

  if (!keyInfo?.algorithm) {
    throw new Error("Secret storage key metadata missing or has no algorithm");
  }
  if (keyInfo.algorithm !== SECRET_STORAGE_ALGORITHM) {
    throw new Error(
      `Unsupported secret storage algorithm: ${keyInfo.algorithm} (expected ${SECRET_STORAGE_ALGORITHM})`,
    );
  }

  return { keyId, keyInfo };
}

/**
 * Derive AES-256 and HMAC-256 keys from a recovery key using HKDF-SHA256.
 */
function deriveKeys(
  recoveryKey: Uint8Array,
  secretName: string,
): { aesKey: Uint8Array; hmacKey: Uint8Array } {
  const zeroSalt = Buffer.alloc(32);
  const info = Buffer.from(secretName, "utf-8");

  const derived = crypto.hkdfSync("sha256", recoveryKey, zeroSalt, info, 64);
  const derivedBuf = Buffer.from(derived);
  return {
    aesKey: new Uint8Array(derivedBuf.subarray(0, 32)),
    hmacKey: new Uint8Array(derivedBuf.subarray(32, 64)),
  };
}

/**
 * Constant-time comparison of two buffers.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Decrypt an encrypted secret from Matrix secret storage (SSSS).
 *
 * Uses HKDF-SHA256 for key derivation, HMAC-SHA256 for MAC verification,
 * and AES-256-CTR for decryption.
 */
export function decryptSecret(
  encrypted: EncryptedSecret,
  recoveryKey: Uint8Array,
  secretName: string,
): Uint8Array {
  const { aesKey, hmacKey } = deriveKeys(recoveryKey, secretName);

  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const expectedMac = Buffer.from(encrypted.mac, "base64");

  // Verify MAC (HMAC-SHA256 over ciphertext)
  const hmac = crypto.createHmac("sha256", hmacKey);
  hmac.update(ciphertext);
  const computedMac = new Uint8Array(hmac.digest());

  if (!constantTimeEqual(computedMac, new Uint8Array(expectedMac))) {
    throw new Error("MAC verification failed — wrong recovery key?");
  }

  // Decrypt with AES-256-CTR
  const decipher = crypto.createDecipheriv("aes-256-ctr", aesKey, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return new Uint8Array(decrypted);
}

/**
 * Derive an Ed25519 public key from a 32-byte private key seed.
 * Returns the base64-unpadded public key.
 */
function deriveEd25519PublicKey(seed: Uint8Array): string {
  const privKey = crypto.createPrivateKey({
    key: buildEd25519Pkcs8(seed),
    format: "der",
    type: "pkcs8",
  });
  // Derive the public key object, then export as SPKI DER
  const pubKey = crypto.createPublicKey(privKey);
  const pubRaw = pubKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI DER: 12-byte header + 32-byte public key
  const pubBytes = new Uint8Array(pubRaw).slice(-32);
  return Buffer.from(pubBytes).toString("base64").replace(/=+$/, "");
}

/**
 * Wrap a 32-byte Ed25519 seed in PKCS8 DER format.
 */
function buildEd25519Pkcs8(seed: Uint8Array): Buffer {
  // PKCS8 wrapper for Ed25519: OID 1.3.101.112
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, seed]);
}

/**
 * Fetch and decrypt all three cross-signing keys from secret storage.
 */
export async function fetchCrossSigningKeys(
  client: MatrixClient,
  recoveryKey: Uint8Array,
  keyId: string,
): Promise<CrossSigningKeys> {
  const types = [
    { eventType: ACCOUNT_DATA_TYPES.crossSigningMaster, label: "master" },
    { eventType: ACCOUNT_DATA_TYPES.crossSigningSelfSigning, label: "self-signing" },
    { eventType: ACCOUNT_DATA_TYPES.crossSigningUserSigning, label: "user-signing" },
  ] as const;

  const keys: Uint8Array[] = [];
  const publicKeys: string[] = [];

  for (const { eventType, label } of types) {
    // eslint-disable-next-line -- bot-sdk account data accessor is untyped
    const accountData = await (client as any).getAccountData(eventType);
    const encrypted: EncryptedSecret | undefined = accountData?.encrypted?.[keyId];
    if (!encrypted) {
      throw new Error(`Could not find encrypted ${label} key in account data`);
    }

    // HKDF info must be the secret's own event type, not the storage key name
    const decryptedBytes = decryptSecret(encrypted, recoveryKey, eventType);

    // The decrypted value is base64-encoded
    const decoded = Buffer.from(Buffer.from(decryptedBytes).toString("utf-8"), "base64");
    keys.push(new Uint8Array(decoded));
    publicKeys.push(deriveEd25519PublicKey(new Uint8Array(decoded)));
  }

  return {
    masterKey: keys[0]!,
    masterKeyPublic: publicKeys[0]!,
    selfSigningKey: keys[1]!,
    selfSigningKeyPublic: publicKeys[1]!,
    userSigningKey: keys[2]!,
    userSigningKeyPublic: publicKeys[2]!,
  };
}
