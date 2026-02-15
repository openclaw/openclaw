/**
 * Cryptographic utilities for recovery key verification.
 */

import {
  BASE58_ALPHABET,
  RECOVERY_KEY_BASE58_LENGTH,
  RECOVERY_KEY_DECODED_LENGTH,
  AES_KEY_LENGTH,
  ERROR_MESSAGES,
} from "./constants.js";

/**
 * Decode a Base58-encoded Matrix recovery key.
 *
 * @param raw - User-provided recovery key (may contain whitespace)
 * @returns Decoded 32-byte AES key
 * @throws Error if format is invalid or parity check fails
 *
 * @example
 * const key = decodeRecoveryKey("EsTc 5rr1 4Jhp Uc18 hwCn 2b9T LSvj 5h4T TkP8 bdeK JGTa");
 * // Returns Uint8Array of 32 bytes
 */
export function decodeRecoveryKey(raw: string): Uint8Array {
  // Normalize: remove whitespace and convert to consistent format
  const normalized = raw.replace(/\s/g, "");

  // Validate minimum length (Base58 encoding of 33 bytes can vary in length)
  if (normalized.length === 0) {
    throw new Error(ERROR_MESSAGES.INVALID_KEY_FORMAT);
  }

  // Validate characters
  for (const char of normalized) {
    if (!BASE58_ALPHABET.includes(char)) {
      throw new Error(ERROR_MESSAGES.INVALID_KEY_CHARACTERS);
    }
  }

  // Decode Base58 to bytes
  const decoded = base58Decode(normalized);

  // Matrix recovery keys decode to 35 bytes: [0x8b, 0x01, ...32 key bytes..., parity]
  if (decoded.length !== RECOVERY_KEY_DECODED_LENGTH) {
    throw new Error(
      `Decoded key has invalid length: ${decoded.length} (expected ${RECOVERY_KEY_DECODED_LENGTH})`,
    );
  }

  // Verify the 2-byte prefix (0x8b 0x01) per Matrix spec MSC1946
  if (decoded[0] !== 0x8b || decoded[1] !== 0x01) {
    throw new Error(
      `Invalid recovery key prefix: expected [0x8b, 0x01], got [0x${decoded[0].toString(16)}, 0x${decoded[1].toString(16)}]`,
    );
  }

  // Extract 32-byte key (skip 2-byte prefix)
  const keyBytes = decoded.slice(2, 34);

  // Extract parity byte (last byte)
  const parityByte = decoded[34];

  // Verify parity byte (XOR of all key bytes per Matrix spec v1.11)
  // https://spec.matrix.org/v1.11/client-server-api/#recovery-keys
  // "compute a parity byte by XORing all bytes of the resulting string"
  // where "resulting string" is after prepending the prefix (first 34 bytes)
  let computedParity = 0;
  for (let i = 0; i < 34; i++) {
    computedParity ^= decoded[i];
  }

  if (computedParity !== parityByte) {
    throw new Error(ERROR_MESSAGES.INVALID_PARITY);
  }

  return keyBytes;
}

/**
 * Decode a Base58 string to bytes using Bitcoin alphabet.
 *
 * @param encoded - Base58-encoded string
 * @returns Decoded bytes
 */
function base58Decode(encoded: string): Uint8Array {
  const base = BigInt(BASE58_ALPHABET.length);
  let result = BigInt(0);

  // Convert Base58 string to big integer
  for (const char of encoded) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new Error(ERROR_MESSAGES.INVALID_KEY_CHARACTERS);
    }
    result = result * base + BigInt(digit);
  }

  // Convert big integer to bytes
  const bytes: number[] = [];
  while (result > 0n) {
    bytes.unshift(Number(result & 0xffn));
    result = result >> 8n;
  }

  // Handle leading zeros (represented as '1' in Base58)
  for (const char of encoded) {
    if (char !== BASE58_ALPHABET[0]) {
      break;
    }
    bytes.unshift(0);
  }

  return new Uint8Array(bytes);
}
