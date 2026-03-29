import { keccak_256 } from "@noble/hashes/sha3.js";
import { fromHex } from "./crypto.js";
import type { DcapVerifier, DcapVerifyResult } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface AttestationResponse {
  verified?: boolean;
  nonce: string;
  model: string;
  intel_quote?: string;
  signing_address?: string;
  signing_key?: string;
  signing_public_key?: string;
  nvidia_payload?: string;
  server_verification?: ServerVerification;
  tee_provider?: string;
}

export interface ServerVerification {
  tdx?: {
    valid: boolean;
    error?: string;
    signatureValid?: boolean;
    certificateChainValid?: boolean;
    attestationKeyMatch?: boolean;
  };
  nvidia?: { valid: boolean; error?: string };
  signingAddressBinding?: {
    bound: boolean;
    reportDataAddress?: string;
    error?: string;
  };
  nonceBinding?: {
    bound: boolean;
    method?: "sha256" | "raw";
    error?: string;
  };
  verifiedAt: string;
  verificationDurationMs: number;
}

export interface AttestationResult {
  /** Client nonce was found in REPORTDATA bytes 32-63 */
  nonceVerified: boolean;
  /** Signing key Ethereum address matches REPORTDATA bytes 0-19 */
  signingKeyBound: boolean;
  /** TEE is running in debug mode (untrusted) */
  debugMode: boolean;
  /** Server-side TDX DCAP verification result (null if not present) */
  serverTdxValid: boolean | null;
  /** Full DCAP verification result (present when dcapVerifier was provided) */
  dcap?: DcapVerifyResult;
  /** List of verification failures */
  errors: string[];
}

// ── TDX quote layout ──────────────────────────────────────────────────
// Header: 48 bytes (version, attestationKeyType, teeType, ...)
// TDX Body starts at offset 48:
//   tdAttributes   @ body+120  (8 bytes)
//   reportData     @ body+520  (64 bytes)

const TDX_BODY_OFFSET = 48;
const TD_ATTRIBUTES_OFFSET = TDX_BODY_OFFSET + 120;
const TD_ATTRIBUTES_LEN = 8;
const REPORT_DATA_OFFSET = TDX_BODY_OFFSET + 520;
const REPORT_DATA_LEN = 64;
const MIN_QUOTE_LEN = REPORT_DATA_OFFSET + REPORT_DATA_LEN; // 632 bytes

const TDX_TEE_TYPE = 0x00000081;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Derive an Ethereum address from an uncompressed secp256k1 public key.
 * address = keccak256(pubkey_64_bytes).slice(12)
 */
export function deriveEthAddress(pubKeyHex: string): Uint8Array {
  let hex = pubKeyHex.startsWith("0x") ? pubKeyHex.slice(2) : pubKeyHex;
  if (hex.length === 128) hex = "04" + hex;
  if (hex.length !== 130 || !hex.startsWith("04")) {
    throw new Error(`Invalid uncompressed secp256k1 public key (got ${hex.length} hex chars)`);
  }
  const keyBytes = fromHex(hex.slice(2)); // 64 bytes without 04 prefix
  const hash = keccak_256(keyBytes);
  return hash.slice(12); // last 20 bytes
}

/** Constant-time comparison of two byte arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** Parse a TDX quote and extract fields needed for verification. */
function parseTdxQuote(quoteHex: string) {
  const hex = quoteHex.startsWith("0x") ? quoteHex.slice(2) : quoteHex;
  const bytes = fromHex(hex);

  if (bytes.length < MIN_QUOTE_LEN) {
    throw new Error(`TDX quote too short: ${bytes.length} bytes (need >= ${MIN_QUOTE_LEN})`);
  }

  // teeType is a uint32LE at offset 4
  const teeType = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  if (teeType !== TDX_TEE_TYPE) {
    throw new Error(`Not a TDX quote: teeType=0x${teeType.toString(16)} (expected 0x81)`);
  }

  return {
    tdAttributes: bytes.slice(TD_ATTRIBUTES_OFFSET, TD_ATTRIBUTES_OFFSET + TD_ATTRIBUTES_LEN),
    reportData: bytes.slice(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + REPORT_DATA_LEN),
  };
}

// ── Main verification ─────────────────────────────────────────────────

/**
 * Verify a Venice TEE attestation response.
 *
 * Always runs v1 binding checks:
 * 1. Parse TDX quote, reject debug mode
 * 2. Verify client nonce in REPORTDATA bytes 32-63 (raw or SHA-256)
 * 3. Verify signing key's Ethereum address in REPORTDATA bytes 0-19
 * 4. Cross-check server's own verification results
 *
 * When `dcapVerifier` is provided, also runs full DCAP verification
 * (cert chain, quote signature, TCB level evaluation).
 *
 * @param response - Full attestation endpoint response
 * @param clientNonce - The 32 raw nonce bytes sent to the endpoint
 * @param dcapVerifier - Optional DCAP verifier function
 * @returns AttestationResult with per-check pass/fail and error list
 */
export async function verifyAttestation(
  response: AttestationResponse,
  clientNonce: Uint8Array,
  dcapVerifier?: DcapVerifier,
): Promise<AttestationResult> {
  const errors: string[] = [];
  let nonceVerified = false;
  let signingKeyBound = false;
  let debugMode = false;
  let serverTdxValid: boolean | null = null;
  let dcap: DcapVerifyResult | undefined;

  if (clientNonce.length !== 32) {
    errors.push(`Invalid client nonce length: ${clientNonce.length} (expected 32)`);
    return { nonceVerified, signingKeyBound, debugMode, serverTdxValid, errors };
  }

  const signingKey = response.signing_key || response.signing_public_key;
  if (!signingKey) {
    errors.push("No signing key in attestation response");
    return { nonceVerified, signingKeyBound, debugMode, serverTdxValid, errors };
  }

  // ── Server-side cross-check ────────────────────────────────────────
  if (response.server_verification) {
    const sv = response.server_verification;
    serverTdxValid = sv.tdx?.valid ?? null;
    if (sv.tdx && !sv.tdx.valid) {
      errors.push(`Server TDX verification failed: ${sv.tdx.error || "unknown reason"}`);
    }
  }

  // ── Client-side quote checks ───────────────────────────────────────
  if (!response.intel_quote) {
    errors.push("No intel_quote in attestation response — cannot verify client-side");
    return { nonceVerified, signingKeyBound, debugMode, serverTdxValid, errors };
  }

  let reportData: Uint8Array;
  let tdAttributes: Uint8Array;
  try {
    ({ reportData, tdAttributes } = parseTdxQuote(response.intel_quote));
  } catch (e) {
    errors.push(`Failed to parse TDX quote: ${(e as Error).message}`);
    return { nonceVerified, signingKeyBound, debugMode, serverTdxValid, errors };
  }

  // Check 1: Debug mode
  debugMode = (tdAttributes[0] & 0x01) !== 0;
  if (debugMode) {
    errors.push("TEE is running in DEBUG mode — attestation cannot be trusted");
  }

  // Check 2: Nonce binding (try raw first, then SHA-256)
  const nonceInReport = reportData.slice(32, 64);
  if (constantTimeEqual(nonceInReport, clientNonce)) {
    nonceVerified = true;
  } else {
    const hashInput = new ArrayBuffer(clientNonce.byteLength);
    new Uint8Array(hashInput).set(clientNonce);
    const hashedNonce = new Uint8Array(await crypto.subtle.digest("SHA-256", hashInput));
    if (constantTimeEqual(nonceInReport, hashedNonce)) {
      nonceVerified = true;
    } else {
      errors.push("Nonce verification failed: client nonce not found in REPORTDATA");
    }
  }

  // Check 3: Signing key → Ethereum address binding
  try {
    const expectedAddress = deriveEthAddress(signingKey);
    const addressInReport = reportData.slice(0, 20);
    signingKeyBound = constantTimeEqual(addressInReport, expectedAddress);
    if (!signingKeyBound) {
      errors.push("Signing key not bound to TEE: Ethereum address mismatch in REPORTDATA");
    }
  } catch (e) {
    errors.push(`Failed to verify signing key binding: ${(e as Error).message}`);
  }

  // Check 4: Cross-check server binding results against our own
  if (response.server_verification?.signingAddressBinding) {
    const sab = response.server_verification.signingAddressBinding;
    if (signingKeyBound !== sab.bound) {
      errors.push(
        `Signing key binding inconsistency: client=${signingKeyBound}, server=${sab.bound}`,
      );
    }
  }
  if (response.server_verification?.nonceBinding) {
    const nb = response.server_verification.nonceBinding;
    if (nonceVerified !== nb.bound) {
      errors.push(`Nonce binding inconsistency: client=${nonceVerified}, server=${nb.bound}`);
    }
  }

  // Check 5: Full DCAP verification (if verifier provided)
  if (dcapVerifier && response.intel_quote) {
    const quoteHex = response.intel_quote.startsWith("0x")
      ? response.intel_quote.slice(2)
      : response.intel_quote;
    try {
      dcap = await dcapVerifier(fromHex(quoteHex));
      // Reject revoked TCB; warn on out-of-date
      const status = dcap.status;
      if (status === "Revoked") {
        errors.push("DCAP verification: TCB status is Revoked");
      } else if (status === "OutOfDate" || status === "OutOfDateConfigurationNeeded") {
        errors.push(
          `DCAP verification: TCB status is ${status} — platform firmware may need updating`,
        );
      }
    } catch (e) {
      errors.push(`DCAP verification failed: ${(e as Error).message}`);
    }
  }

  return { nonceVerified, signingKeyBound, debugMode, serverTdxValid, dcap, errors };
}
