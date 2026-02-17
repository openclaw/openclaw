/**
 * W3C Decentralized Identifier (DID) implementation for The Six Fingered Man.
 *
 * Supports:
 * - did:key generation from Ed25519 keypairs
 * - did:key resolution (deterministic, no network)
 * - Signing and verification with DID-linked keys
 *
 * Encoding: Ed25519 public key → multicodec (0xed01) → multibase (base58) → did:key
 *
 * @see https://w3c-ccg.github.io/did-method-key/
 * @see https://www.w3.org/TR/did-core/
 */

import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { base58 } from "@scure/base";
import type { DID, DIDDocument, VerificationMethod } from "../types.js";

// Configure noble/ed25519 synchronous SHA-512.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  let totalLength = 0;
  for (const m of messages) {
    totalLength += m.length;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const m of messages) {
    merged.set(m, offset);
    offset += m.length;
  }
  return sha512(merged);
};

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * Multicodec prefix for Ed25519 public keys.
 * @see https://github.com/multiformats/multicodec/blob/master/table.csv
 */
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/** Expected length of an Ed25519 public key in bytes. */
const ED25519_PUBLIC_KEY_LENGTH = 32;

/** did:key prefix. */
const DID_KEY_PREFIX = "did:key:";

/** Multibase prefix for base58. */
const MULTIBASE_BASE58BTC_PREFIX = "z";

// ── Types ───────────────────────────────────────────────────────────────────

/** A generated DID identity with its associated keypair. */
export interface DIDIdentity {
  /** The W3C DID (did:key:z6Mk...). */
  did: DID;
  /** The raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** The raw 32-byte Ed25519 private key. Keep secret. */
  privateKey: Uint8Array;
}

/** A proof object for signed data, compatible with VC proof format. */
export interface DIDProof {
  type: "Ed25519Signature2020";
  verificationMethod: string;
  created: string;
  proofValue: string;
}

// ── DID Generation ──────────────────────────────────────────────────────────

/**
 * Generate a new DID identity with a fresh Ed25519 keypair.
 *
 * @returns A DIDIdentity containing the did:key, public key, and private key.
 */
export function generateDID(): DIDIdentity {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const did = didFromPublicKey(publicKey);
  return { did, publicKey, privateKey };
}

/**
 * Derive a did:key from an existing Ed25519 public key.
 *
 * Encoding steps:
 * 1. Prepend multicodec prefix (0xed 0x01) to the 32-byte public key
 * 2. Encode as base58
 * 3. Prepend multibase prefix 'z'
 * 4. Prepend 'did:key:'
 *
 * @param publicKey - Raw 32-byte Ed25519 public key.
 * @returns The did:key identifier.
 * @throws {Error} if publicKey is not 32 bytes.
 */
export function didFromPublicKey(publicKey: Uint8Array): DID {
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Invalid Ed25519 public key length: expected ${ED25519_PUBLIC_KEY_LENGTH}, got ${publicKey.length}`,
    );
  }

  // Prepend multicodec prefix
  const multicodecKey = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  multicodecKey.set(ED25519_MULTICODEC_PREFIX, 0);
  multicodecKey.set(publicKey, ED25519_MULTICODEC_PREFIX.length);

  // Encode as base58 with multibase prefix
  const encoded = MULTIBASE_BASE58BTC_PREFIX + base58.encode(multicodecKey);

  return `did:key:${encoded}` as DID;
}

// ── DID Resolution ──────────────────────────────────────────────────────────

/**
 * Extract the raw Ed25519 public key from a did:key.
 *
 * @param did - A did:key identifier.
 * @returns The raw 32-byte Ed25519 public key.
 * @throws {Error} if the DID is not a valid did:key or uses a non-Ed25519 key type.
 */
export function publicKeyFromDID(did: DID): Uint8Array {
  if (!did.startsWith(DID_KEY_PREFIX)) {
    throw new Error(`Not a did:key identifier: ${did}`);
  }

  const multibaseEncoded = did.slice(DID_KEY_PREFIX.length);

  // Verify multibase prefix (must be 'z' for base58)
  if (!multibaseEncoded.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
    throw new Error(
      `Unsupported multibase encoding: expected '${MULTIBASE_BASE58BTC_PREFIX}', got '${multibaseEncoded[0]}'`,
    );
  }

  // Decode base58 (strip the 'z' prefix)
  const decoded = base58.decode(multibaseEncoded.slice(1));

  // Verify multicodec prefix
  if (
    decoded.length < ED25519_MULTICODEC_PREFIX.length ||
    decoded[0] !== ED25519_MULTICODEC_PREFIX[0] ||
    decoded[1] !== ED25519_MULTICODEC_PREFIX[1]
  ) {
    throw new Error("Unsupported key type: expected Ed25519 multicodec prefix (0xed01)");
  }

  // Extract public key (everything after the 2-byte prefix)
  const publicKey = decoded.slice(ED25519_MULTICODEC_PREFIX.length);

  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Invalid public key length after decoding: expected ${ED25519_PUBLIC_KEY_LENGTH}, got ${publicKey.length}`,
    );
  }

  return publicKey;
}

/**
 * Resolve a did:key to its DID Document.
 *
 * For did:key, resolution is deterministic and local — no network call needed.
 * The DID Document is constructed directly from the encoded public key.
 *
 * @param did - A did:key identifier.
 * @returns The DID Document.
 */
export function resolveDID(did: DID): DIDDocument {
  // Verify it's a valid did:key by extracting the public key
  publicKeyFromDID(did);

  // The key ID is the DID with a fragment referencing itself
  const multibaseEncoded = did.slice(DID_KEY_PREFIX.length);
  const keyId = `${did}#${multibaseEncoded}`;

  const verificationMethod: VerificationMethod = {
    id: keyId,
    type: "Ed25519VerificationKey2020",
    controller: did,
    publicKeyMultibase: multibaseEncoded,
  };

  return {
    "@context": "https://www.w3.org/ns/did/v1",
    id: did,
    verificationMethod: [verificationMethod],
    authentication: [keyId],
    assertionMethod: [keyId],
  };
}

// ── Signing & Verification ──────────────────────────────────────────────────

/**
 * Sign arbitrary data using a DID's private key.
 *
 * @param data - The data to sign (will be SHA-256 hashed before signing).
 * @param privateKey - The raw 32-byte Ed25519 private key.
 * @param did - The signer's DID (used in the proof's verificationMethod).
 * @returns A DIDProof containing the signature and metadata.
 */
export function signWithDID(data: Uint8Array, privateKey: Uint8Array, did: DID): DIDProof {
  // Hash the data with SHA-256 to produce a fixed-size message
  const hash = sha256(data);
  const signature = ed25519.sign(hash, privateKey);

  const multibaseEncoded = did.slice(DID_KEY_PREFIX.length);
  const keyId = `${did}#${multibaseEncoded}`;

  return {
    type: "Ed25519Signature2020",
    verificationMethod: keyId,
    created: new Date().toISOString(),
    proofValue: MULTIBASE_BASE58BTC_PREFIX + base58.encode(signature),
  };
}

/**
 * Verify a signature against a DID.
 *
 * Resolves the DID to extract the public key, then verifies the signature.
 *
 * @param data - The original data that was signed.
 * @param proof - The DIDProof containing the signature.
 * @param did - The signer's DID.
 * @returns `true` if the signature is valid.
 */
export function verifyWithDID(data: Uint8Array, proof: DIDProof, did: DID): boolean {
  try {
    const publicKey = publicKeyFromDID(did);

    // Decode the signature from multibase
    if (!proof.proofValue.startsWith(MULTIBASE_BASE58BTC_PREFIX)) {
      return false;
    }
    const signature = base58.decode(proof.proofValue.slice(1));

    if (signature.length !== 64) {
      return false;
    }

    // Hash the data the same way as signWithDID
    const hash = sha256(data);

    return ed25519.verify(signature, hash, publicKey);
  } catch {
    return false;
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Check whether a string is a valid did:key identifier.
 *
 * Validates the format and attempts to decode the public key.
 */
export function isValidDIDKey(did: string): did is DID {
  try {
    if (!did.startsWith(DID_KEY_PREFIX)) {
      return false;
    }
    publicKeyFromDID(did as DID);
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a hex string to a Uint8Array.
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Invalid hex string: odd length");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert a Uint8Array to a hex string.
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
