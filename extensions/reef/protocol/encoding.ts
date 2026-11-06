import { Buffer } from "node:buffer";

export { bytesToHex as hex, utf8ToBytes as utf8 } from "@noble/ciphers/utils.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

export function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const output = Buffer.from(value, "base64url");
  if (output.toString("base64url") !== value) {
    throw new Error("invalid base64url padding");
  }
  return Uint8Array.from(output);
}

export function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function fromBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("invalid base64");
  }
  const output = Buffer.from(value, "base64");
  if (output.toString("base64") !== value) {
    throw new Error("non-canonical base64");
  }
  return Uint8Array.from(output);
}
