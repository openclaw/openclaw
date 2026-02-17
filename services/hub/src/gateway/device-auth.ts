import crypto from "node:crypto";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyBase64Url: string;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  const deviceId = crypto.createHash("sha256").update(raw).digest("hex");
  const publicKeyBase64Url = base64UrlEncode(raw);
  return { deviceId, publicKeyPem, privateKeyPem, publicKeyBase64Url };
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
}): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}

/**
 * Build the paired.json content that pre-registers a device with the gateway.
 */
export function buildPairedDevicesJson(device: DeviceIdentity): string {
  const now = Date.now();
  const paired = {
    [device.deviceId]: {
      deviceId: device.deviceId,
      publicKey: device.publicKeyBase64Url,
      displayName: "hub-operator",
      platform: "docker",
      clientId: "gateway-client",
      clientMode: "backend",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      createdAtMs: now,
      approvedAtMs: now,
    },
  };
  return JSON.stringify(paired);
}
