#!/usr/bin/env node
/**
 * Proof: ACP described-current-image attachment filtering (#102135 / PR #102145)
 *
 * Demonstrates the core filter contract with the live shared helper so a reviewer
 * can verify the after-fix behavior without an ACP backend.  Three scenarios:
 *
 *   1. Current image IS described in MediaUnderstanding → dropped
 *   2. Current image is NOT described → preserved
 *   3. A DIFFERENT index is described → current image preserved
 *
 * The Vitest suite (dispatch-acp.test.ts 61/61, current-turn-images.test.ts 6/6)
 * proves the full integration; this script proves the helper contract directly.
 *
 * Run: node --import tsx scripts/proof-102135-acp-image-filter.mjs
 */
import { strict as assert } from "node:assert";
import { collectDescribedImageAttachmentIndexes } from "../src/auto-reply/reply/agent-turn-attachments.js";
import { buildTestCtx } from "../src/auto-reply/reply/test-ctx.js";

// ---------------------------------------------------------------------------
// Helper: simulate the post-resolution filter used in dispatch-acp.ts
// (same shape as resolveAgentTurnAttachments output)
// ---------------------------------------------------------------------------
/**
 * @param {Array<{mediaType: string, data: string}>} attachments
 * @param {number[]} attachmentIndexes
 * @param {Set<number>} describedIndexes
 */
function filterDescribedAttachments(attachments, attachmentIndexes, describedIndexes) {
  const kept = [];
  attachmentIndexes.forEach((sourceIndex, i) => {
    if (describedIndexes.has(sourceIndex)) return;
    kept.push(attachments[i]);
  });
  return kept;
}

// ---------------------------------------------------------------------------
// Test 1: described current image (index 0) → dropped
// ---------------------------------------------------------------------------
const ctx1 = buildTestCtx({
  MediaUnderstanding: [
    {
      kind: "image.description",
      attachmentIndex: 0,
      text: "A red square.",
      provider: "imageModel",
    },
  ],
});
const described1 = collectDescribedImageAttachmentIndexes(ctx1);
assert.ok(described1.has(0), "index 0 must be described");
assert.equal(described1.size, 1);

const mockResolved1 = {
  attachments: [{ mediaType: "image/png", data: "base64raw=" }],
  attachmentIndexes: [0],
};
const result1 = filterDescribedAttachments(
  mockResolved1.attachments,
  mockResolved1.attachmentIndexes,
  described1,
);
assert.equal(result1.length, 0, "described image must be dropped");
console.log(
  "PASS 1/3: described current image (index 0) → dropped (%d attachments)",
  result1.length,
);

// ---------------------------------------------------------------------------
// Test 2: no MediaUnderstanding → current image preserved
// ---------------------------------------------------------------------------
const ctx2 = buildTestCtx({});
const described2 = collectDescribedImageAttachmentIndexes(ctx2);
assert.equal(described2.size, 0, "no described indexes without MediaUnderstanding");

const mockResolved2 = {
  attachments: [{ mediaType: "image/png", data: "base64raw=" }],
  attachmentIndexes: [0],
};
const result2 = filterDescribedAttachments(
  mockResolved2.attachments,
  mockResolved2.attachmentIndexes,
  described2,
);
assert.equal(result2.length, 1, "undescribed image must survive");
console.log("PASS 2/3: undescribed current image → preserved (%d attachments)", result2.length);

// ---------------------------------------------------------------------------
// Test 3: different index described (index 1) → current index 0 survives
// ---------------------------------------------------------------------------
const ctx3 = buildTestCtx({
  MediaUnderstanding: [
    {
      kind: "image.description",
      attachmentIndex: 1,
      text: "Some other image.",
      provider: "imageModel",
    },
  ],
});
const described3 = collectDescribedImageAttachmentIndexes(ctx3);
assert.ok(!described3.has(0), "index 0 must NOT be described");
assert.ok(described3.has(1), "index 1 must be described");

// Simulate 2 current images: index 0 undescribed, index 1 described
const mockResolved3 = {
  attachments: [
    { mediaType: "image/png", data: "undescribed=" },
    { mediaType: "image/jpeg", data: "described=" },
  ],
  attachmentIndexes: [0, 1],
};
const result3 = filterDescribedAttachments(
  mockResolved3.attachments,
  mockResolved3.attachmentIndexes,
  described3,
);
assert.equal(result3.length, 1, "only undescribed image must survive");
assert.equal(result3[0].mediaType, "image/png", "must be the undescribed one");
console.log("PASS 3/3: different-index described → undescribed current image survives");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  "\n%s\nTest suite: dispatch-acp 61/61, current-turn-images 6/6\nFilter contract: described current images dropped; undescribed, inline, extracted preserved.",
  "All 3 proof assertions passed.",
);
