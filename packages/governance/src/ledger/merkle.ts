/**
 * Merkle tree for batching event hashes.
 *
 * 100 events → 1 Merkle root (32 bytes).
 * Any single event verifiable against the root via a proof path.
 *
 * Uses SHA-256 for internal nodes: hash(left || right).
 * Leaf nodes are the event hashes themselves (already SHA-256).
 * Odd-count levels duplicate the last node (standard Merkle padding).
 */

import { sha256 } from "@noble/hashes/sha256";

/** A proof path for verifying a leaf against a Merkle root. */
export interface MerkleProof {
  /** The leaf hash being proven. */
  leaf: Uint8Array;
  /** Proof siblings, bottom to top. */
  siblings: Array<{
    /** The sibling hash at this level. */
    hash: Uint8Array;
    /** Which side the sibling is on ("left" or "right"). */
    position: "left" | "right";
  }>;
}

/**
 * Build a Merkle tree from an array of leaf hashes.
 *
 * @param leaves - Array of 32-byte SHA-256 hashes (event hashes).
 * @returns All tree levels, bottom (leaves) to top (root). Last level has 1 element.
 * @throws {Error} if leaves array is empty.
 */
export function buildMerkleTree(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) {
    throw new Error("Cannot build Merkle tree from empty leaf set");
  }

  const levels: Uint8Array[][] = [leaves];

  let currentLevel = leaves;

  while (currentLevel.length > 1) {
    const nextLevel: Uint8Array[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      // If odd number of nodes, duplicate the last one
      const right = currentLevel[i + 1] ?? left;
      nextLevel.push(hashPair(left, right));
    }

    levels.push(nextLevel);
    currentLevel = nextLevel;
  }

  return levels;
}

/**
 * Get the Merkle root from an array of leaf hashes.
 *
 * @param leaves - Array of 32-byte SHA-256 hashes.
 * @returns The 32-byte Merkle root hash.
 */
export function getMerkleRoot(leaves: Uint8Array[]): Uint8Array {
  const levels = buildMerkleTree(leaves);
  return levels[levels.length - 1][0];
}

/**
 * Generate a Merkle proof for a specific leaf.
 *
 * @param leaves - All leaf hashes in the tree.
 * @param leafIndex - Index of the leaf to prove.
 * @returns A MerkleProof that can verify the leaf against the root.
 * @throws {Error} if leafIndex is out of bounds.
 */
export function getMerkleProof(leaves: Uint8Array[], leafIndex: number): MerkleProof {
  if (leafIndex < 0 || leafIndex >= leaves.length) {
    throw new Error(`Leaf index ${leafIndex} out of bounds (0-${leaves.length - 1})`);
  }

  const levels = buildMerkleTree(leaves);
  const siblings: MerkleProof["siblings"] = [];

  let index = leafIndex;

  // Walk up the tree, collecting siblings
  for (let level = 0; level < levels.length - 1; level++) {
    const currentLevel = levels[level];
    const isLeft = index % 2 === 0;
    const siblingIndex = isLeft ? index + 1 : index - 1;

    // If sibling doesn't exist (odd count), it's a duplicate of us
    const sibling = currentLevel[siblingIndex] ?? currentLevel[index];

    siblings.push({
      hash: sibling,
      position: isLeft ? "right" : "left",
    });

    // Move to parent index
    index = Math.floor(index / 2);
  }

  return {
    leaf: leaves[leafIndex],
    siblings,
  };
}

/**
 * Verify a Merkle proof against an expected root.
 *
 * @param proof - The proof to verify.
 * @param expectedRoot - The expected Merkle root.
 * @returns `true` if the proof is valid.
 */
export function verifyMerkleProof(proof: MerkleProof, expectedRoot: Uint8Array): boolean {
  let current = proof.leaf;

  for (const sibling of proof.siblings) {
    if (sibling.position === "left") {
      current = hashPair(sibling.hash, current);
    } else {
      current = hashPair(current, sibling.hash);
    }
  }

  return bytesEqual(current, expectedRoot);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Hash two 32-byte nodes together: SHA-256(left || right). */
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return sha256(combined);
}

/** Constant-time byte array comparison. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
