import { Type } from "typebox";

/**
 * Shortest hash prefix a write fence accepts. Fences guard against concurrent and
 * external edits to one record selected by ID, not against an adversary forging
 * content, so 64 bits of the SHA-256 content hash are ample; lists return prefixes
 * of this length and single-record reads and receipts return the full hash.
 */
export const HASH_PREFIX_CHARS = 16;

/** Observed record hash for a write fence: the full hash or its leading 16+ characters. */
export const ExpectedHash = Type.String({
  pattern: `^[a-f0-9]{${HASH_PREFIX_CHARS},64}$`,
  description: `The record's current hash: the full 64-character value, or its first ${HASH_PREFIX_CHARS} or more characters as lists return it.`,
});

/** List-row form of a record hash. */
export const hashPrefix = (hash: string) => hash.slice(0, HASH_PREFIX_CHARS);

/** The one write-fence hash comparison: full hash or a lowercase hex prefix of 16+ characters. */
export function hashMatches(actual: string, expected: string): boolean {
  if (expected.length < HASH_PREFIX_CHARS || !/^[a-f0-9]+$/u.test(expected)) {
    throw new Error(
      `expectedHash must be the full record hash or its first ${HASH_PREFIX_CHARS} or more lowercase hex characters. No publication accepted.`,
    );
  }
  return actual.startsWith(expected);
}
