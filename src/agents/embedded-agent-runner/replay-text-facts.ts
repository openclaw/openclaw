import { createHash } from "node:crypto";
import { normalizeUserMessageContent } from "./compaction-duplicate-user-messages.js";

/** Composable bucket key. Equality is always verified by a selected source comparison. */
export type ReplayTextFingerprint = { hash: string; length: number; normalizedLength: number };
const MASK = (1n << 64n) - 1n;
const BASE = 257n;

export function collectReplayTextFingerprint(text: string): ReplayTextFingerprint {
  const normalized = normalizeUserMessageContent(text)!;
  const canonical = normalized.normalize("NFC");
  let hash = 0n;
  for (let index = 0; index < canonical.length; index++) {
    hash = (hash * BASE + BigInt(canonical.charCodeAt(index))) & MASK;
  }
  return { hash: hash.toString(16), length: canonical.length, normalizedLength: normalized.length };
}

export function joinReplayTextFingerprints(
  parts: readonly ReplayTextFingerprint[],
): ReplayTextFingerprint {
  let hash = 0n;
  let length = 0;
  let normalizedLength = 0;
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    if (length > 0) {
      hash = (hash * BASE + 32n) & MASK;
      length++;
      normalizedLength++;
    }
    let power = BASE;
    let exponent = part.length;
    let multiplier = 1n;
    while (exponent > 0) {
      if (exponent % 2 === 1) {
        multiplier = (multiplier * power) & MASK;
      }
      power = (power * power) & MASK;
      exponent = Math.floor(exponent / 2);
    }
    hash = (hash * multiplier + BigInt(`0x${part.hash}`)) & MASK;
    length += part.length;
    normalizedLength += part.normalizedLength;
  }
  return { hash: hash.toString(16), length, normalizedLength };
}

/** Object-key ordering does not affect deep equality of persisted plain JSON records. */
export function replayComparisonFingerprint(value: unknown): string {
  const hash = createHash("sha256");
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      hash.update("[");
      for (const element of item) {
        visit(element);
      }
      hash.update("]");
    } else if (item && typeof item === "object") {
      hash.update("{");
      for (const key of Object.keys(item).toSorted()) {
        hash.update(JSON.stringify(key));
        visit(Reflect.get(item, key));
      }
      hash.update("}");
    } else {
      hash.update(`${typeof item}:${JSON.stringify(item)};`);
    }
  };
  visit(value);
  return hash.digest("hex");
}
