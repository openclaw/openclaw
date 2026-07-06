/**
 * Proof script for #100254: claude-sonnet-5 adaptive thinking allowlist
 *
 * Validates that claude-sonnet-5 is now recognized as supporting
 * adaptive thinking and native max effort in the model-contracts layer.
 *
 * Usage: npx tsx proof-100254.ts
 */

import {
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
  resolveClaudeModelIdentity,
} from "@openclaw/llm-core";

function check(name: string, fn: () => boolean, expected: boolean) {
  const result = fn();
  const ok = result === expected;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${result}, expected ${expected}`);
  return ok;
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => boolean, expected: boolean) {
  if (check(name, fn, expected)) passed++;
  else failed++;
}

console.log("=== #100254 proof: claude-sonnet-5 model-contract allowlists ===\n");

// --- Adaptive thinking (the reported bug) ---
console.log("supportsClaudeAdaptiveThinking:");
test("  sonnet-5 (bare)", () => supportsClaudeAdaptiveThinking({ id: "claude-sonnet-5" }), true);
test(
  "  sonnet-5 with anthropic/ prefix",
  () => supportsClaudeAdaptiveThinking({ id: "anthropic/claude-sonnet-5" }),
  true,
);
test(
  "  sonnet-5 with date suffix",
  () => supportsClaudeAdaptiveThinking({ id: "claude-sonnet-5@20260701" }),
  true,
);
test(
  "  sonnet-4-6 still works",
  () => supportsClaudeAdaptiveThinking({ id: "claude-sonnet-4-6" }),
  true,
);
test(
  "  sonnet-4-60 not a match",
  () => supportsClaudeAdaptiveThinking({ id: "claude-sonnet-4-60" }),
  false,
);

// --- Native max effort (cascading: needs this for default effort) ---
console.log("\nsupportsClaudeNativeMaxEffort:");
test("  sonnet-5 (bare)", () => supportsClaudeNativeMaxEffort({ id: "claude-sonnet-5" }), true);
test(
  "  sonnet-5 with prefix",
  () => supportsClaudeNativeMaxEffort({ id: "anthropic/claude-sonnet-5" }),
  true,
);
test(
  "  sonnet-4-6 still works",
  () => supportsClaudeNativeMaxEffort({ id: "claude-sonnet-4-6" }),
  true,
);
test("  fable-5 still works", () => supportsClaudeNativeMaxEffort({ id: "claude-fable-5" }), true);

// --- Xhigh: sonnet-5 SHOULD support xhigh (added per ClawSweeper review) ---
console.log("\nsupportsClaudeNativeXhighEffort:");
test(
  "  sonnet-5 DOES support xhigh",
  () => supportsClaudeNativeXhighEffort({ id: "claude-sonnet-5" }),
  true,
);
test(
  "  sonnet-5 with date suffix supports xhigh",
  () => supportsClaudeNativeXhighEffort({ id: "claude-sonnet-5@20260701" }),
  true,
);
test(
  "  opus-4-8 DOES support xhigh",
  () => supportsClaudeNativeXhighEffort({ id: "claude-opus-4-8" }),
  true,
);
test(
  "  sonnet-4-6 does NOT support xhigh",
  () => supportsClaudeNativeXhighEffort({ id: "claude-sonnet-4-6" }),
  false,
);
test(
  "  sonnet-50 does NOT match xhigh",
  () => supportsClaudeNativeXhighEffort({ id: "claude-sonnet-50" }),
  false,
);

// --- Model identity normalization ---
console.log("\nresolveClaudeModelIdentity:");
test(
  "  anthropic/claude-sonnet-5 → claude-sonnet-5",
  () => resolveClaudeModelIdentity({ id: "anthropic/claude-sonnet-5" }) === "claude-sonnet-5",
  true,
);
test(
  "  claude-sonnet-5 → claude-sonnet-5",
  () => resolveClaudeModelIdentity({ id: "claude-sonnet-5" }) === "claude-sonnet-5",
  true,
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
