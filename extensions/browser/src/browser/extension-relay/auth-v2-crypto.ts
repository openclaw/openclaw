import crypto from "node:crypto";
import {
  canonicalRelayAuthProofBytes,
  type RelayAuthProofFields as BrowserRelayProofFields,
} from "../../../chrome-extension/modules/relay-auth-v2-crypto.js";

export {
  RELAY_AUTH_LABEL as BROWSER_RELAY_AUTH_LABEL,
  RELAY_AUTH_VERSION as BROWSER_RELAY_AUTH_VERSION,
  type RelayAuthProofFields as BrowserRelayProofFields,
} from "../../../chrome-extension/modules/relay-auth-v2-crypto.js";

const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

type BrowserRelayProofKind = "server" | "client" | "accept";

export type BrowserRelayAuthChallenge = BrowserRelayProofFields & {
  type: "auth.challenge";
  v: 2;
  serverProof: string;
};

export type BrowserRelayAuthOk = {
  type: "auth.ok";
  v: 2;
  sessionId: string;
  acceptProof: string;
};

function decodeRelayKey(keyHex: string): Buffer {
  if (!KEY_HEX_PATTERN.test(keyHex)) {
    throw new Error("browser relay key must be 32 lowercase-hex bytes");
  }
  return Buffer.from(keyHex, "hex");
}

export function isCanonicalBase64UrlBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === bytes && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

export function isBase64UrlText(value: string): boolean {
  return BASE64URL_PATTERN.test(value);
}

export function relayKeyIdFromHex(keyHex: string): string {
  return crypto
    .createHash("sha256")
    .update(decodeRelayKey(keyHex))
    .digest("base64url")
    .slice(0, 22);
}

export function randomRelayNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function randomRelayId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function createRelayProof(
  keyHex: string,
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  clientProof?: string,
): string {
  const hmac = crypto.createHmac("sha256", decodeRelayKey(keyHex));
  if (proofKind === "accept" && !isCanonicalBase64UrlBytes(clientProof, 32)) {
    throw new Error("accept proof requires a 32-byte client proof");
  }
  return hmac
    .update(canonicalRelayAuthProofBytes(proofKind, fields, clientProof))
    .digest("base64url");
}

export function verifyRelayProof(
  keyHex: string,
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  candidate: unknown,
  clientProof?: string,
): boolean {
  if (!isCanonicalBase64UrlBytes(candidate, 32)) {
    return false;
  }
  const expected = Buffer.from(
    createRelayProof(keyHex, proofKind, fields, clientProof),
    "base64url",
  );
  const actual = Buffer.from(candidate, "base64url");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
