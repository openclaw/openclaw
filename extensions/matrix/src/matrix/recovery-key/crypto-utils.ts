import {
  BASE58_ALPHABET,
  RECOVERY_KEY_DECODED_LENGTH,
  RECOVERY_KEY_LENGTH,
  RECOVERY_KEY_PREFIX,
} from "./constants.js";

/**
 * Decode a Base58-encoded string using the Bitcoin alphabet.
 * Returns the raw bytes.
 */
export function base58Decode(encoded: string): Uint8Array {
  const alphabetMap = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    alphabetMap.set(BASE58_ALPHABET[i]!, i);
  }

  // Count leading '1's (zero bytes)
  let leadingZeros = 0;
  for (const ch of encoded) {
    if (ch === "1") {
      leadingZeros++;
    } else {
      break;
    }
  }

  // Decode base58 to big integer via repeated multiply-and-add.
  // Process every byte on each input character to propagate the 58x
  // multiplication through all positions, not just those with carry.
  const size = Math.ceil((encoded.length * Math.log(58)) / Math.log(256));
  const bytes = new Uint8Array(size);

  for (const ch of encoded) {
    let carry = alphabetMap.get(ch);
    if (carry === undefined) {
      throw new Error(`Invalid Base58 character: ${ch}`);
    }
    for (let j = size - 1; j >= 0; j--) {
      carry += 58 * (bytes[j] ?? 0);
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
  }

  // Strip leading zero bytes from the computation, then prepend the counted zeros
  let startIdx = 0;
  while (startIdx < bytes.length && bytes[startIdx] === 0) {
    startIdx++;
  }
  const result = new Uint8Array(leadingZeros + (bytes.length - startIdx));
  // leading zeros are already 0 in the Uint8Array
  result.set(bytes.subarray(startIdx), leadingZeros);
  return result;
}

/**
 * Decode a Matrix recovery key string into a 32-byte key.
 *
 * Recovery key format: Base58-encoded bytes with:
 *   - 2-byte prefix (0x8b 0x01)
 *   - 32-byte key material
 *   - 1-byte parity (XOR of all preceding bytes)
 *
 * Spaces are stripped before decoding.
 */
export function decodeRecoveryKey(raw: string): Uint8Array {
  // Strip spaces (recovery keys are often displayed in groups of 4)
  const cleaned = raw.replace(/\s+/g, "");

  const decoded = base58Decode(cleaned);

  if (decoded.length !== RECOVERY_KEY_DECODED_LENGTH) {
    throw new Error(
      `Recovery key has wrong length: expected ${RECOVERY_KEY_DECODED_LENGTH} bytes, got ${decoded.length}`,
    );
  }

  // Validate prefix
  if (decoded[0] !== RECOVERY_KEY_PREFIX[0] || decoded[1] !== RECOVERY_KEY_PREFIX[1]) {
    throw new Error("Recovery key has invalid prefix");
  }

  // Validate parity byte (XOR of all bytes except the last)
  let parity = 0;
  for (let i = 0; i < decoded.length - 1; i++) {
    parity ^= decoded[i]!;
  }
  if (parity !== decoded[decoded.length - 1]) {
    throw new Error("Recovery key parity check failed");
  }

  // Extract the 32-byte key material (skip 2-byte prefix, exclude 1-byte parity)
  return decoded.slice(2, 2 + RECOVERY_KEY_LENGTH);
}
