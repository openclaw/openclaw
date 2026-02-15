/**
 * Device signing utilities for Matrix device verification.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import crypto from "node:crypto";
import { ERROR_MESSAGES } from "./constants.js";

/**
 * Device keys structure following Matrix Client-Server API spec.
 */
export interface DeviceKeys {
  /** Matrix user ID */
  userId: string;
  /** Matrix device ID */
  deviceId: string;
  /** Device keys (ed25519 and curve25519) */
  keys: {
    [keyId: string]: string;
  };
  /** Supported encryption algorithms */
  algorithms: string[];
}

/**
 * Get current device keys from Matrix client crypto engine.
 *
 * @param client - Matrix client instance
 * @returns Device keys structure
 * @throws Error if crypto engine is unavailable
 *
 * @example
 * const deviceKeys = await getCurrentDeviceKeys(client);
 * console.log(deviceKeys.deviceId); // "ABCD1234EFGH"
 */
export async function getCurrentDeviceKeys(client: MatrixClient): Promise<DeviceKeys> {
  // Check if crypto is available
  if (!client.crypto) {
    throw new Error(ERROR_MESSAGES.CRYPTO_ENGINE_UNAVAILABLE);
  }

  // Get device ID and user ID from client
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bot-SDK does not expose deviceId in CryptoClient types
  const deviceId = (client.crypto as any).deviceId as string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bot-SDK does not expose userId in MatrixClient types
  const userId = (client as any).userId as string | undefined;

  if (!deviceId) {
    throw new Error("Device ID not available from client");
  }

  if (!userId) {
    throw new Error("User ID not available from client");
  }

  // Get identity keys directly from crypto object (bot-sdk exposes them as properties)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bot-SDK does not expose crypto properties in types
  const cryptoAny = client.crypto as any;
  const ed25519Key = cryptoAny.deviceEd25519;
  const curve25519Key = cryptoAny.deviceCurve25519;

  if (!ed25519Key || !curve25519Key) {
    throw new Error("Identity keys not available from crypto engine");
  }

  // Construct device keys structure per Matrix spec
  return {
    userId,
    deviceId,
    keys: {
      [`ed25519:${deviceId}`]: ed25519Key,
      [`curve25519:${deviceId}`]: curve25519Key,
    },
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
  };
}

/**
 * Sign device keys with self-signing key.
 *
 * @param deviceKeys - Device keys to sign
 * @param selfSigningKey - Self-signing private key (32 bytes ed25519)
 * @returns Base64-encoded signature (unpadded)
 *
 * @example
 * const signature = signDevice(deviceKeys, selfSigningPrivateKey);
 * // Returns "base64_encoded_signature..."
 */
export function signDevice(deviceKeys: DeviceKeys, selfSigningKey: Uint8Array): string {
  // Construct canonical JSON payload per Matrix spec
  const payload = {
    user_id: deviceKeys.userId,
    device_id: deviceKeys.deviceId,
    keys: deviceKeys.keys,
    algorithms: deviceKeys.algorithms,
  };

  // Convert payload to canonical JSON (sorted keys, no whitespace)
  const canonicalJson = canonicalJsonStringify(payload);

  // Sign with ed25519 using Node.js crypto
  // Node.js crypto API requires Ed25519 keys in PKCS8 format
  // Wrap raw 32-byte private key with standard PKCS8 header (DER-encoded ASN.1)
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

  const pkcs8Key = Buffer.concat([pkcs8Header, Buffer.from(selfSigningKey)]);

  const keyObject = crypto.createPrivateKey({
    key: pkcs8Key,
    format: "der",
    type: "pkcs8",
  });

  const signature = crypto.sign(null, Buffer.from(canonicalJson), keyObject);

  // Matrix expects unpadded Base64
  return signature.toString("base64").replace(/=+$/, "");
}

/**
 * Convert object to canonical JSON string (sorted keys, no whitespace).
 * This follows the Matrix specification for signing JSON objects.
 *
 * @param obj - Object to stringify
 * @returns Canonical JSON string
 */
function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return "null";
  }

  if (typeof obj === "boolean") {
    return obj.toString();
  }

  if (typeof obj === "number") {
    return obj.toString();
  }

  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const items = obj.map(canonicalJsonStringify);
    return `[${items.join(",")}]`;
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJsonStringify(value)}`);
    return `{${entries.join(",")}}`;
  }

  throw new Error(`Cannot canonicalize type: ${typeof obj}`);
}

/**
 * Upload device signature to Matrix homeserver.
 *
 * @param client - Matrix client instance
 * @param userId - User ID
 * @param deviceId - Device ID
 * @param deviceKeys - Device keys structure
 * @param signature - Base64-encoded signature
 * @param selfSigningKeyId - Self-signing key ID (Base64-encoded public key)
 * @throws Error if upload fails
 *
 * @example
 * await uploadDeviceSignature(client, "@user:example.com", "DEVICE123", deviceKeys, signature, keyId);
 */
export async function uploadDeviceSignature(
  client: MatrixClient,
  userId: string,
  deviceId: string,
  deviceKeys: DeviceKeys,
  signature: string,
  selfSigningKeyId: string,
): Promise<void> {
  // Construct request body per Matrix spec
  // https://spec.matrix.org/v1.11/client-server-api/#post_matrixclientv3keyssignaturesupload
  const body = {
    [userId]: {
      [deviceId]: {
        user_id: userId,
        device_id: deviceId,
        algorithms: deviceKeys.algorithms,
        keys: deviceKeys.keys,
        signatures: {
          [userId]: {
            [`ed25519:${selfSigningKeyId}`]: signature,
          },
        },
      },
    },
  };

  try {
    // Upload signature to homeserver
    await client.doRequest("POST", "/_matrix/client/v3/keys/signatures/upload", null, body);
  } catch (error) {
    // Handle specific API errors
    if (error && typeof error === "object" && "statusCode" in error) {
      const statusCode = (error as { statusCode: number }).statusCode;

      if (statusCode === 429) {
        throw new Error("Rate limited by homeserver - please try again later");
      }

      if (statusCode === 400) {
        throw new Error("Invalid signature - signature verification failed on homeserver");
      }
    }

    // Re-throw with more context
    if (error instanceof Error) {
      throw new Error(`Failed to upload device signature: ${error.message}`);
    }

    throw new Error("Failed to upload device signature: unknown error");
  }
}
