/**
 * Matrix secret storage operations for recovery key verification.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import crypto from "node:crypto";
import type { SecretStorageKeyInfo, EncryptedSecret, CrossSigningKeys } from "./types.js";
import {
  ACCOUNT_DATA_TYPES,
  SECRET_STORAGE_ALGORITHM,
  ERROR_MESSAGES,
  AES_KEY_LENGTH,
  ED25519_KEY_LENGTH,
} from "./constants.js";

/**
 * Fetch secret storage metadata from Matrix account data.
 *
 * @param client - Matrix client instance
 * @returns Secret storage key information
 * @throws Error if secret storage is not configured or metadata is missing
 */
export async function fetchSecretStorageMetadata(
  client: MatrixClient,
): Promise<SecretStorageKeyInfo> {
  const userId = await client.getUserId();

  // Fetch default key ID from account data
  const defaultKeyUrl = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA_TYPES.SECRET_STORAGE_DEFAULT_KEY}`;

  let defaultKeyData: { key?: string };
  try {
    defaultKeyData = (await client.doRequest("GET", defaultKeyUrl)) as { key?: string };
  } catch (error) {
    throw new Error(ERROR_MESSAGES.SECRET_STORAGE_NOT_CONFIGURED);
  }

  const keyId = defaultKeyData.key;
  if (!keyId) {
    throw new Error(ERROR_MESSAGES.SECRET_STORAGE_NOT_CONFIGURED);
  }

  // Fetch key metadata from account data
  const keyMetadataUrl = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA_TYPES.SECRET_STORAGE_KEY_PREFIX}${encodeURIComponent(keyId)}`;

  let keyMetadata: {
    algorithm?: string;
    iv?: string;
    mac?: string;
    passphrase?: {
      algorithm: string;
      salt: string;
      iterations: number;
    };
  };
  try {
    keyMetadata = (await client.doRequest("GET", keyMetadataUrl)) as typeof keyMetadata;
  } catch (error) {
    throw new Error(ERROR_MESSAGES.SECRET_STORAGE_KEY_NOT_FOUND);
  }

  // Validate algorithm
  if (keyMetadata.algorithm !== SECRET_STORAGE_ALGORITHM) {
    throw new Error(ERROR_MESSAGES.INVALID_ALGORITHM);
  }

  // Validate required fields
  if (!keyMetadata.iv || !keyMetadata.mac) {
    throw new Error(ERROR_MESSAGES.SECRET_STORAGE_KEY_NOT_FOUND);
  }

  return {
    algorithm: keyMetadata.algorithm,
    keyId,
    iv: keyMetadata.iv,
    mac: keyMetadata.mac,
    passphrase: keyMetadata.passphrase,
  };
}

/**
 * Derive Ed25519 public key from private key.
 *
 * @param privateKey - 32-byte Ed25519 private key
 * @returns Base64-encoded (unpadded) public key
 */
function derivePublicKey(privateKey: Uint8Array): string {
  // Node.js crypto API requires Ed25519 keys in PKCS8 format
  // Wrap raw 32-byte private key with standard PKCS8 header
  const pkcs8Header = Buffer.from([
    0x30,
    0x2e, // SEQUENCE, length 46
    0x02,
    0x01,
    0x00, // INTEGER 0 (version)
    0x30,
    0x05, // SEQUENCE, length 5
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70, // OID 1.3.101.112 (Ed25519)
    0x04,
    0x22, // OCTET STRING, length 34
    0x04,
    0x20, // OCTET STRING, length 32 (the actual key)
  ]);

  const pkcs8Key = Buffer.concat([pkcs8Header, Buffer.from(privateKey)]);

  const keyObject = crypto.createPrivateKey({
    key: pkcs8Key,
    format: "der",
    type: "pkcs8",
  });

  // Export public key
  const publicKeyObject = crypto.createPublicKey(keyObject);
  const publicKeyDer = publicKeyObject.export({ type: "spki", format: "der" }) as Buffer;

  // Extract raw 32-byte public key from SPKI structure
  // SPKI format: [header (12 bytes)] [32-byte public key]
  const rawPublicKey = publicKeyDer.slice(-32);

  // Return unpadded Base64
  return rawPublicKey.toString("base64").replace(/=+$/, "");
}

/**
 * Decrypt a secret from Matrix account data using recovery key.
 *
 * Implements Matrix SSSS (Secure Secret Storage and Sharing) decryption:
 * 1. Derives separate AES and HMAC keys from recovery key using HKDF-SHA256
 * 2. Verifies MAC (computed on ciphertext only) before decryption
 * 3. Decrypts using AES-256-CTR with derived key
 *
 * @param encrypted - Encrypted secret with iv, ciphertext, and mac
 * @param recoveryKey - 32-byte recovery key
 * @param secretName - Name of the secret (e.g., "m.cross_signing.master")
 * @returns Decrypted secret bytes
 * @throws Error if MAC verification fails or decryption fails
 */
export function decryptSecret(
  encrypted: EncryptedSecret,
  recoveryKey: Uint8Array,
  secretName: string,
): Uint8Array {
  // Decode Base64 fields
  const iv = Buffer.from(encrypted.iv, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const expectedMac = Buffer.from(encrypted.mac, "base64");

  // Derive separate AES and HMAC keys using HKDF-SHA256
  // HKDF needed to generate cryptographically independent keys from single recovery key
  // Matrix SSSS spec: HKDF with 8 zero bytes salt, secret name as info
  // https://spec.matrix.org/v1.11/client-server-api/#msecret_storagev1aes-hmac-sha2
  const zeroSalt = Buffer.alloc(8);
  const info = Buffer.from(secretName, "utf8");

  const derivedKeys = crypto.hkdfSync(
    "sha256", // hash algorithm
    recoveryKey, // input key material
    zeroSalt, // salt (8 zero bytes)
    info, // info (UTF-8 encoded secret name)
    64, // output length (64 bytes)
  );

  // Ensure slices are Buffer type for crypto operations
  const aesKey = Buffer.from(derivedKeys.slice(0, 32)); // First 32 bytes for AES-256
  const hmacKey = Buffer.from(derivedKeys.slice(32, 64)); // Last 32 bytes for HMAC

  // Compute HMAC-SHA256 on ciphertext only (not iv + ciphertext)
  const hmac = crypto.createHmac("sha256", hmacKey);
  hmac.update(ciphertext);
  const computedMac = hmac.digest();

  // Verify MAC using constant-time comparison
  if (!crypto.timingSafeEqual(computedMac, expectedMac)) {
    throw new Error(ERROR_MESSAGES.MAC_VERIFICATION_FAILED);
  }

  // Decrypt using AES-256-CTR with derived key
  const decipher = crypto.createDecipheriv("aes-256-ctr", aesKey, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // The decrypted data is a Base64-encoded string, decode it to get raw bytes
  const decryptedString = decrypted.toString("utf8");
  const decodedBytes = Buffer.from(decryptedString, "base64");

  return new Uint8Array(decodedBytes);
}

/**
 * Fetch and decrypt cross-signing keys from Matrix account data.
 *
 * @param client - Matrix client instance
 * @param recoveryKey - 32-byte recovery key for decryption
 * @returns Cross-signing keys (master, self-signing, user-signing)
 * @throws Error if keys are missing or decryption fails
 */
export async function fetchCrossSigningKeys(
  client: MatrixClient,
  recoveryKey: Uint8Array,
): Promise<CrossSigningKeys> {
  const userId = await client.getUserId();

  // Fetch encrypted master key
  const masterKeyUrl = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA_TYPES.CROSS_SIGNING_MASTER}`;
  let masterKeyData: {
    encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }>;
    [key: string]: unknown;
  };
  try {
    masterKeyData = (await client.doRequest("GET", masterKeyUrl)) as typeof masterKeyData;
  } catch (error) {
    throw new Error(ERROR_MESSAGES.CROSS_SIGNING_NOT_CONFIGURED);
  }

  // Fetch encrypted self-signing key
  const selfSigningKeyUrl = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA_TYPES.CROSS_SIGNING_SELF_SIGNING}`;
  let selfSigningKeyData: {
    encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }>;
    [key: string]: unknown;
  };
  try {
    selfSigningKeyData = (await client.doRequest(
      "GET",
      selfSigningKeyUrl,
    )) as typeof selfSigningKeyData;
  } catch (error) {
    throw new Error(ERROR_MESSAGES.SELF_SIGNING_KEY_MISSING);
  }

  // Fetch encrypted user-signing key
  const userSigningKeyUrl = `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${ACCOUNT_DATA_TYPES.CROSS_SIGNING_USER_SIGNING}`;
  let userSigningKeyData: {
    encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }>;
    [key: string]: unknown;
  };
  try {
    userSigningKeyData = (await client.doRequest(
      "GET",
      userSigningKeyUrl,
    )) as typeof userSigningKeyData;
  } catch (error) {
    throw new Error(ERROR_MESSAGES.USER_SIGNING_KEY_MISSING);
  }

  // Get secret storage key ID to find the correct encrypted secret
  const metadata = await fetchSecretStorageMetadata(client);
  const keyId = metadata.keyId;

  // Decrypt master key
  const masterEncrypted = masterKeyData.encrypted?.[keyId];
  if (!masterEncrypted) {
    throw new Error(ERROR_MESSAGES.MASTER_KEY_MISSING);
  }
  const masterPrivateKey = decryptSecret(
    masterEncrypted,
    recoveryKey,
    ACCOUNT_DATA_TYPES.CROSS_SIGNING_MASTER,
  );
  if (masterPrivateKey.length !== ED25519_KEY_LENGTH) {
    throw new Error(ERROR_MESSAGES.INVALID_KEY_LENGTH);
  }

  // Decrypt self-signing key
  const selfSigningEncrypted = selfSigningKeyData.encrypted?.[keyId];
  if (!selfSigningEncrypted) {
    throw new Error(ERROR_MESSAGES.SELF_SIGNING_KEY_MISSING);
  }
  const selfSigningPrivateKey = decryptSecret(
    selfSigningEncrypted,
    recoveryKey,
    ACCOUNT_DATA_TYPES.CROSS_SIGNING_SELF_SIGNING,
  );
  if (selfSigningPrivateKey.length !== ED25519_KEY_LENGTH) {
    throw new Error(ERROR_MESSAGES.INVALID_KEY_LENGTH);
  }

  // Decrypt user-signing key
  const userSigningEncrypted = userSigningKeyData.encrypted?.[keyId];
  if (!userSigningEncrypted) {
    throw new Error(ERROR_MESSAGES.USER_SIGNING_KEY_MISSING);
  }
  const userSigningPrivateKey = decryptSecret(
    userSigningEncrypted,
    recoveryKey,
    ACCOUNT_DATA_TYPES.CROSS_SIGNING_USER_SIGNING,
  );
  if (userSigningPrivateKey.length !== ED25519_KEY_LENGTH) {
    throw new Error(ERROR_MESSAGES.INVALID_KEY_LENGTH);
  }

  // Derive public keys from private keys
  const masterPublicKey = derivePublicKey(masterPrivateKey);
  const selfSigningPublicKey = derivePublicKey(selfSigningPrivateKey);
  const userSigningPublicKey = derivePublicKey(userSigningPrivateKey);

  return {
    master: {
      publicKey: masterPublicKey,
      privateKey: masterPrivateKey,
    },
    selfSigning: {
      publicKey: selfSigningPublicKey,
      privateKey: selfSigningPrivateKey,
    },
    userSigning: {
      publicKey: userSigningPublicKey,
      privateKey: userSigningPrivateKey,
    },
  };
}
