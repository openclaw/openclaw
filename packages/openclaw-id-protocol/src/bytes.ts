// Byte helpers shared by Node, browsers and Workers. No Buffer, no node:* imports.

/** Byte array backed by a plain ArrayBuffer, as WebCrypto requires. */
export type Bytes = Uint8Array<ArrayBuffer>;

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

/** Copies any Uint8Array into a WebCrypto-compatible byte array. */
export function toBytes(input: Uint8Array): Bytes {
  return new Uint8Array(input);
}

/** Encodes bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Decodes lowercase hex. Uppercase and odd lengths are rejected so one value has one spelling. */
export function hexToBytes(hex: string): Bytes {
  if (!HEX_RE.test(hex)) {
    throw new Error("expected lowercase hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encodes a string as UTF-8. */
export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

/** Concatenates byte arrays. */
export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Constant-shape comparison of two byte arrays. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Encodes bytes as unpadded base64url (RFC 4648 section 5). */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes unpadded base64url. Padding and the standard alphabet are rejected. */
export function base64urlToBytes(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error("expected unpadded base64url");
  }
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  if (bytesToBase64url(out) !== text) {
    throw new Error("non-canonical base64url");
  }
  return out;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encodes bytes as Crockford base32 (no padding, upper case), most significant bit first. */
export function bytesToCrockford(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += CROCKFORD[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/** Decodes Crockford base32. Accepts lower case and the I/L->1, O->0 aliases humans type. */
export function crockfordToBytes(text: string, byteLength: number): Bytes {
  const out = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const raw of text.toUpperCase()) {
    const char = raw === "I" || raw === "L" ? "1" : raw === "O" ? "0" : raw;
    const value = CROCKFORD.indexOf(char);
    if (value < 0) {
      throw new Error("invalid base32 character");
    }
    buffer = ((buffer << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index >= byteLength) {
        throw new Error("base32 value too long");
      }
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  if (index !== byteLength) {
    throw new Error("base32 value too short");
  }
  return out;
}
