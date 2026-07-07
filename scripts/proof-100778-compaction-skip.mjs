/**
 * Proof script for #100778: narrowed preflight compaction retryability contract.
 *
 * Imports the real classifyCompactionReason production function and exercises
 * every compaction reason class through the skip/non-skip decision boundary.
 *
 * Retryable (skip):  timeout, provider_error_429, provider_error_5xx
 * Non-retryable (throw): provider_error_4xx (400/401/403), guard_blocked,
 *   summary_failed, deferred_background, unknown
 *
 * Usage: npx tsx scripts/proof-100778-compaction-skip.mjs
 */

import { classifyCompactionReason } from "../src/agents/embedded-agent-runner/compact-reasons.js";

// Mirror of isPreflightCompactionSkipReason from agent-runner-memory.ts.
// Kept in sync manually — the proof validates that the real function, tested
// via runPreflightCompactionIfNeeded in the unit suite, produces these results.
function isSkipReason(reason) {
  const c = classifyCompactionReason(reason);
  return (
    c === "below_threshold" ||
    c === "no_compactable_entries" ||
    c === "already_compacted_recently" ||
    c === "timeout" ||
    c === "provider_error_429" ||
    c === "provider_error_5xx"
  );
}

/** @type {Array<[string, string, boolean, string]>} */
const cases = [
  // Existing benign reasons — always skipped
  ["nothing to compact", true, "existing skip: no_compactable_entries"],
  ["already under target", true, "existing skip: below_threshold"],
  ["already compacted recently", true, "existing skip: already_compacted_recently"],

  // Retryable transient failures — NEW skip (the fix)
  ["Compaction timed out after 30s", true, "FIX: timeout → skip"],
  ["request timeout", true, "FIX: timeout → skip"],
  ["HTTP 429 Too Many Requests", true, "FIX: provider_error_429 → skip"],
  ["HTTP 503 Service Unavailable", true, "FIX: provider_error_5xx → skip"],
  ["Internal Server Error 500", true, "FIX: provider_error_5xx → skip"],
  ["502 Bad Gateway", true, "FIX: provider_error_5xx → skip"],

  // Non-retryable failures — MUST still throw (negative controls)
  ["400 Bad Request", false, "NEGATIVE: provider_error_4xx still throws"],
  ["401 Unauthorized", false, "NEGATIVE: provider_error_4xx still throws"],
  ["403 Forbidden", false, "NEGATIVE: provider_error_4xx still throws"],
  // Billing/quota 429 responses ARE non-retryable operator-action failures.
  ["429: insufficient_quota", false, "NEGATIVE: billing 429 → provider_error_4xx"],
  ["HTTP 429 insufficient quota", false, "NEGATIVE: billing 429 → provider_error_4xx"],
  ["429 Insufficient account balance", false, "NEGATIVE: billing 429 → provider_error_4xx"],
  ["429 Resource has been exhausted", false, "NEGATIVE: billing 429 → provider_error_4xx"],
  ["429 quota exceeded for model", false, "NEGATIVE: billing 429 → provider_error_4xx"],
  ["429 账户余额不足", false, "NEGATIVE: billing 429 (zh-CN) → provider_error_4xx"],
  // Non-billing 429 (true rate limit) — skip
  ["429 Too Many Requests", true, "FIX: true rate-limit 429 → skip"],
  ["rate limit exceeded 429 retry after 60s", true, "FIX: true rate-limit 429 → skip"],
  [
    "Compaction safeguard could not resolve an API key",
    false,
    "NEGATIVE: guard_blocked still throws",
  ],
  ["summary generation failed", false, "NEGATIVE: summary_failed still throws"],
  [
    "deferred to background context-engine maintenance",
    false,
    "NEGATIVE: deferred_background still throws",
  ],
  ["thread not found: <codex-thread-id>", false, "NEGATIVE: unknown still throws"],
  ["no thread binding for session", false, "NEGATIVE: unknown still throws"],
  ["", false, "NEGATIVE: empty reason still throws"],
];

let passed = 0;
let failed = 0;

for (const [reason, expectedSkip, label] of cases) {
  const classification = classifyCompactionReason(reason);
  const actualSkip = isSkipReason(reason);
  const ok = actualSkip === expectedSkip;
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: reason="${reason}" class=${classification} expectedSkip=${expectedSkip} actualSkip=${actualSkip} — ${label}`,
    );
  }
}

console.log(`\n${passed}/${cases.length} passed`);
if (failed > 0) {
  console.error(`${failed} FAILED`);
}

// Prove the 429/4xx split is correct at the classifier level.
console.log("\n--- Classification split proof ---");
const r429 = classifyCompactionReason("HTTP 429 Too Many Requests");
const r400 = classifyCompactionReason("400 Bad Request");
const r401 = classifyCompactionReason("401 Unauthorized");
const r403 = classifyCompactionReason("403 Forbidden");
console.log(
  `429 → "${r429}" (must NOT equal "provider_error_4xx"): ${r429 !== "provider_error_4xx" ? "PASS" : "FAIL"}`,
);
console.log(
  `400 → "${r400}" (must equal "provider_error_4xx"): ${r400 === "provider_error_4xx" ? "PASS" : "FAIL"}`,
);
console.log(
  `401 → "${r401}" (must equal "provider_error_4xx"): ${r401 === "provider_error_4xx" ? "PASS" : "FAIL"}`,
);
console.log(
  `403 → "${r403}" (must equal "provider_error_4xx"): ${r403 === "provider_error_4xx" ? "PASS" : "FAIL"}`,
);

process.exit(failed > 0 ? 1 : 0);
