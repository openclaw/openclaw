// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/governance/aibom_signer.py.

import crypto, { type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const JWS_ALG = "EdDSA" as const;
const DEFAULT_KID = "openclaw-governance-v1";

export type Ed25519KeyPair = {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
};

export type VerifyStatus = "verified" | "tampered" | "unverified" | "invalid";

export type VerifyResult = {
  status: VerifyStatus;
  kid?: string;
  signedAt?: string;
  error?: string;
};

function b64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Buffer {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function canonicalJson(record: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(record, Object.keys(record).toSorted()), "utf8");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).toSorted()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalSerialize(record: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(record)), "utf8");
}

function generateNewKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
  };
}

export type SignerOptions = {
  keyDir?: string;
  kid?: string;
};

export class AibomSigner {
  private readonly keyPair: Ed25519KeyPair;

  constructor(keyPair: Ed25519KeyPair) {
    this.keyPair = keyPair;
  }

  static fromKeyDir(opts: SignerOptions = {}): AibomSigner {
    const keyDir = opts.keyDir ?? resolveDefaultKeyDir();
    const kid = opts.kid ?? DEFAULT_KID;
    const privatePath = resolve(keyDir, "aibom-key.ed25519");
    const publicPath = resolve(keyDir, "aibom-key.pub");

    if (!existsSync(privatePath) || !existsSync(publicPath)) {
      mkdirSync(dirname(privatePath), { recursive: true });
      const { privateKeyPem, publicKeyPem } = generateNewKeyPair();
      writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
      writeFileSync(publicPath, publicKeyPem, { mode: 0o644 });
    }

    const privatePem = readFileSync(privatePath, "utf8");
    const publicPem = readFileSync(publicPath, "utf8");
    const privateKey = crypto.createPrivateKey(privatePem);
    const publicKey = crypto.createPublicKey(publicPem);
    return new AibomSigner({ kid, privateKey, publicKey });
  }

  static generateEphemeral(kid = "ephemeral"): AibomSigner {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return new AibomSigner({ kid, privateKey, publicKey });
  }

  publicKeyPem(): string {
    return this.keyPair.publicKey.export({ format: "pem", type: "spki" });
  }

  kid(): string {
    return this.keyPair.kid;
  }

  sign(record: Record<string, unknown>): string {
    const header = {
      alg: JWS_ALG,
      typ: "JWT",
      kid: this.keyPair.kid,
      iat: Math.floor(Date.now() / 1000),
    };
    const headerB64 = b64urlEncode(canonicalJson(header));
    const payloadB64 = b64urlEncode(canonicalSerialize(record));
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
    const signature = crypto.sign(null, signingInput, this.keyPair.privateKey);
    const sigB64 = b64urlEncode(signature);
    return `${headerB64}.${payloadB64}.${sigB64}`;
  }

  verify(jws: string | null | undefined, record: Record<string, unknown>): VerifyResult {
    if (!jws) {
      return { status: "unverified" };
    }
    const parts = jws.split(".");
    if (parts.length !== 3) {
      return { status: "invalid", error: "JWS must have 3 parts" };
    }
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    } catch (exc) {
      return { status: "invalid", error: `bad header: ${(exc as Error).message}` };
    }
    if (header.alg !== JWS_ALG) {
      return { status: "invalid", error: `unsupported alg ${String(header.alg)}` };
    }
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const iat = typeof header.iat === "number" ? header.iat : undefined;
    const signedAt = iat !== undefined ? new Date(iat * 1000).toISOString() : undefined;

    const expectedPayload = b64urlEncode(canonicalSerialize(record));
    if (expectedPayload !== parts[1]) {
      return {
        status: "tampered",
        ...(kid !== undefined ? { kid } : {}),
        ...(signedAt !== undefined ? { signedAt } : {}),
        error: "payload does not match signed record",
      };
    }

    if (kid !== this.keyPair.kid && kid !== "ephemeral") {
      return {
        status: "invalid",
        ...(kid !== undefined ? { kid } : {}),
        ...(signedAt !== undefined ? { signedAt } : {}),
        error: `unknown kid ${String(kid)}`,
      };
    }

    try {
      const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "ascii");
      const signature = b64urlDecode(parts[2]);
      const ok = crypto.verify(null, signingInput, this.keyPair.publicKey, signature);
      if (!ok) {
        return {
          status: "tampered",
          ...(kid !== undefined ? { kid } : {}),
          ...(signedAt !== undefined ? { signedAt } : {}),
          error: "signature mismatch",
        };
      }
      return {
        status: "verified",
        ...(kid !== undefined ? { kid } : {}),
        ...(signedAt !== undefined ? { signedAt } : {}),
      };
    } catch (exc) {
      return {
        status: "tampered",
        ...(kid !== undefined ? { kid } : {}),
        ...(signedAt !== undefined ? { signedAt } : {}),
        error: (exc as Error).message,
      };
    }
  }
}

export function resolveDefaultKeyDir(): string {
  const home =
    process.env.HOME ??
    process.env.USERPROFILE ??
    (process.platform === "win32" ? (process.env.APPDATA ?? process.cwd()) : process.cwd());
  return resolve(home, ".openclaw", "governance");
}
