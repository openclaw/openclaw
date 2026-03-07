/**
 * Variable-length integer decoding for Mumble protocol
 * Based on @tf2pickup-org/mumble-client implementation
 */

export interface VarintResult {
  value: number;
  length: number;
}

/**
 * Read varint from buffer
 * Returns { value, length } where length is bytes consumed
 */
export function readVarint(buffer: Buffer): VarintResult {
  let value = 0;
  let shift = 0;
  let length = 0;

  for (let i = 0; i < buffer.length && i < 10; i++) {
    const byte = buffer[i]!;
    length++;

    value |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      break;
    }

    shift += 7;
  }

  return { value, length };
}
