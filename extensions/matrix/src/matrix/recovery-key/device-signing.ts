import crypto from "node:crypto";
import type { MatrixClient } from "@vector-im/matrix-bot-sdk";

/**
 * Extract the current device's keys from the Matrix crypto client.
 * The bot-sdk doesn't expose typed accessors for these, so we use `as any` casts.
 */
export function getCurrentDeviceKeys(client: MatrixClient): {
  deviceId: string;
  userId: string;
  ed25519Key: string;
  curve25519Key: string;
} {
  // eslint-disable-next-line -- bot-sdk internals
  const cryptoClient = client.crypto as any;
  if (!cryptoClient) {
    throw new Error("Matrix client has no crypto module");
  }

  // Access device info from the crypto client internals
  const deviceId: string =
    cryptoClient.clientDeviceId ??
    cryptoClient.deviceId ??
    // eslint-disable-next-line -- fallback to client-level property
    (client as any).deviceId;
  if (!deviceId) {
    throw new Error("Could not determine device ID from crypto client");
  }

  // eslint-disable-next-line -- access userId from client
  const userId: string = (client as any).userId ?? cryptoClient.userId;
  if (!userId) {
    throw new Error("Could not determine user ID from client");
  }

  // CryptoClient exposes clientDeviceEd25519 (public getter) and stores
  // deviceEd25519/deviceCurve25519 as private fields (accessible via `as any`).
  const ed25519Key: string | undefined =
    cryptoClient.clientDeviceEd25519 ?? cryptoClient.deviceEd25519;
  const curve25519Key: string | undefined = cryptoClient.deviceCurve25519;

  if (!ed25519Key || !curve25519Key) {
    throw new Error("Could not extract device keys from crypto client");
  }

  return { deviceId, userId, ed25519Key, curve25519Key };
}

/**
 * Matrix spec canonical JSON: sorted keys, no whitespace.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalJsonStringify((obj as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Wrap a 32-byte Ed25519 seed in PKCS8 DER format for Node.js crypto.
 */
function buildEd25519Pkcs8(seed: Uint8Array): Buffer {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, seed]);
}

/**
 * Sign the device keys object with the self-signing key.
 *
 * Creates a canonical JSON representation of the device keys (without
 * existing signatures/unsigned), signs it with Ed25519, and returns
 * the signature string.
 */
export function signDevice(
  deviceKeys: {
    deviceId: string;
    userId: string;
    ed25519Key: string;
    curve25519Key: string;
  },
  selfSigningKey: Uint8Array,
  selfSigningKeyPublic: string,
): { signature: string; keyId: string } {
  // Build the device keys object as the homeserver expects
  const keysObj: Record<string, unknown> = {
    user_id: deviceKeys.userId,
    device_id: deviceKeys.deviceId,
    algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    keys: {
      [`curve25519:${deviceKeys.deviceId}`]: deviceKeys.curve25519Key,
      [`ed25519:${deviceKeys.deviceId}`]: deviceKeys.ed25519Key,
    },
  };

  // Canonical JSON for signing (no signatures or unsigned fields)
  const canonical = canonicalJsonStringify(keysObj);

  // Sign with the self-signing key
  const keyObj = crypto.createPrivateKey({
    key: buildEd25519Pkcs8(selfSigningKey),
    format: "der",
    type: "pkcs8",
  });

  const signature = crypto.sign(null, Buffer.from(canonical), keyObj);
  const signatureB64 = Buffer.from(signature).toString("base64").replace(/=+$/, "");

  return {
    signature: signatureB64,
    keyId: `ed25519:${selfSigningKeyPublic}`,
  };
}

/**
 * Upload the device signature to the homeserver.
 *
 * POST /_matrix/client/v3/keys/signatures/upload
 */
export async function uploadDeviceSignature(
  client: MatrixClient,
  params: {
    userId: string;
    deviceId: string;
    ed25519Key: string;
    curve25519Key: string;
    signature: string;
    signingKeyId: string;
  },
): Promise<void> {
  const body = {
    [params.userId]: {
      [params.deviceId]: {
        user_id: params.userId,
        device_id: params.deviceId,
        algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
        keys: {
          [`curve25519:${params.deviceId}`]: params.curve25519Key,
          [`ed25519:${params.deviceId}`]: params.ed25519Key,
        },
        signatures: {
          [params.userId]: {
            [params.signingKeyId]: params.signature,
          },
        },
      },
    },
  };

  // eslint-disable-next-line -- bot-sdk doRequest is the raw HTTP method
  const response = await (client as any).doRequest(
    "POST",
    "/_matrix/client/v3/keys/signatures/upload",
    undefined,
    body,
  );

  // Check for failures in the response
  if (response?.failures && Object.keys(response.failures).length > 0) {
    const firstFailure = Object.values(response.failures)[0];
    throw new Error(`Signature upload failed: ${JSON.stringify(firstFailure)}`);
  }
}
