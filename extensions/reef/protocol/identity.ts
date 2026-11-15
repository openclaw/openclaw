import { createPrivateKey, sign } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { canonicalBytes, sha256Hex } from "./canonical.js";
import { base64url, fromBase64url } from "./encoding.js";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SigningKeyPair {
  publicKey: string;
  secretKey: string;
}

export interface EncryptionKeyPair {
  publicKey: string;
  secretKey: string;
}

export interface IdentityKeyPair {
  signing: SigningKeyPair;
  encryption: EncryptionKeyPair;
}

export function generateIdentity(): IdentityKeyPair {
  const signing = ed25519.keygen();
  const encryption = x25519.keygen();
  return {
    signing: { publicKey: base64url(signing.publicKey), secretKey: base64url(signing.secretKey) },
    encryption: {
      publicKey: base64url(encryption.publicKey),
      secretKey: base64url(encryption.secretKey),
    },
  };
}

export interface DeviceRequestSignatureInput {
  method: string;
  path: string;
  ts: number;
  bodySha256: string;
}

export function signDeviceRequest(
  input: DeviceRequestSignatureInput,
  signingSecretKey: string,
): string {
  if (
    !/^[A-Z]+$/.test(input.method) ||
    !input.path.startsWith("/") ||
    !Number.isSafeInteger(input.ts) ||
    input.ts < 0 ||
    !/^[0-9a-f]{64}$/.test(input.bodySha256)
  ) {
    throw new Error("invalid device request signature input");
  }
  const secret = fromBase64url(signingSecretKey);
  if (secret.length !== 32) {
    throw new Error("Ed25519 secret key must contain 32 bytes");
  }
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, secret]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, canonicalBytes(input), key).toString("base64url");
}

export function fingerprint(ed25519PublicKey: string, x25519PublicKey?: string): string {
  const material = x25519PublicKey
    ? canonicalBytes({ ed25519: ed25519PublicKey, x25519: x25519PublicKey })
    : fromBase64url(ed25519PublicKey);
  return sha256Hex(material)
    .match(/.{1,4}/g)!
    .join(" ");
}

export function formatHandleEpoch(handle: string, keyEpoch: number): string {
  if (
    !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/i.test(handle) ||
    !Number.isSafeInteger(keyEpoch) ||
    keyEpoch < 1
  ) {
    throw new Error("invalid handle or key epoch");
  }
  return `${handle}#${keyEpoch}`;
}

export function parseHandleEpoch(value: string): { handle: string; keyEpoch: number } {
  const match = /^([a-z0-9](?:[a-z0-9_-]{0,62}))#([1-9][0-9]*)$/i.exec(value);
  if (!match) {
    throw new Error("invalid handle#key_epoch");
  }
  const keyEpoch = Number(match[2]);
  if (!Number.isSafeInteger(keyEpoch)) {
    throw new Error("invalid key epoch");
  }
  return { handle: match[1]!, keyEpoch };
}
