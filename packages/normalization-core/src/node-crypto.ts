import { Buffer } from "node:buffer";
import { createHash, hash, type Hash } from "node:crypto";
import { writeStableStringify } from "./stable-stringify.js";
import { normalizeOptionalString } from "./string-coerce.js";

export function sha256Hex(input: string | Uint8Array): string {
  return hash("sha256", input, "hex");
}

export function sha256StableValue(value: unknown): { digest: string; byteWeight: number } {
  let digest: Hash | undefined;
  let chunks: string[] = [];
  let characterCount = 0;
  let byteWeight = 0;
  writeStableStringify(value, (chunk) => {
    if (chunk.length === 0) {
      return;
    }
    chunks.push(chunk);
    characterCount += chunk.length;
    if (characterCount >= 16_384) {
      const text = chunks.join("");
      digest ??= createHash("sha256");
      digest.update(text);
      byteWeight += Buffer.byteLength(text);
      chunks = [];
      characterCount = 0;
    }
  });
  // Whole JSON string tokens keep surrogate pairs together at every UTF-8 boundary.
  const text = chunks.join("");
  byteWeight += Buffer.byteLength(text);
  return {
    digest: digest ? digest.update(text).digest("hex") : sha256Hex(text),
    byteWeight,
  };
}

export function sha256HexPrefixCore(input: string | Uint8Array, length: number): string {
  return sha256Hex(input).slice(0, length);
}

/** Redacts an identifier to a stable hash label, or "-" for missing values. */
export function redactIdentifier(value: string | undefined, opts?: { len?: number }): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "-";
  }
  const len = opts?.len ?? 12;
  const safeLen = Number.isFinite(len) ? Math.max(1, Math.floor(len)) : 12;
  return `sha256:${sha256HexPrefixCore(trimmed, safeLen)}`;
}
