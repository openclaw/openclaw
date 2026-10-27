import { randomBytes } from "@noble/hashes/utils.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function createMonotonicUlidFactory(): () => string {
  let lastTime = -1;
  let randomness = new Uint8Array(10);
  return () => {
    const now = Math.floor(Date.now());
    if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
      throw new Error("invalid ULID clock");
    }
    if (now > lastTime) {
      randomness = randomBytes(10);
      lastTime = now;
    } else {
      increment(randomness);
    }
    return encodeCrockford(BigInt(lastTime), 10) + encodeRandom(randomness);
  };
}

function increment(value: Uint8Array): void {
  for (let index = value.length - 1; index >= 0; index--) {
    value[index] = (value[index]! + 1) & 0xff;
    if (value[index] !== 0) {
      return;
    }
  }
  throw new Error("ULID monotonic overflow");
}

function encodeCrockford(input: bigint, length: number): string {
  let value = input;
  let output = "";
  for (let index = 0; index < length; index++) {
    output = CROCKFORD[Number(value & 31n)]! + output;
    value >>= 5n;
  }
  return output;
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return encodeCrockford(value, 16);
}
