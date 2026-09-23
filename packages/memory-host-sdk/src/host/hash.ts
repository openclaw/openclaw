import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

/** SHA-256 hash helper for stable cache/content keys. */
export function hashText(value: string): string {
  return sha256Hex(value);
}
