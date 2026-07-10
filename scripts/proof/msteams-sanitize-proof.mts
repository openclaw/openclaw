/**
 * Delivery-pipeline proof for #103692: msteams sanitizeText strips
 * internal tool-trace banners before outbound transport.
 *
 * Usage: node --import tsx scripts/proof/msteams-sanitize-proof.mts
 */
import { msteamsPlugin } from "../../extensions/msteams/src/channel.js";

const sanitizeText = msteamsPlugin.outbound?.sanitizeText;
if (!sanitizeText) {
  console.error("FAIL: msteamsPlugin.outbound.sanitizeText is missing");
  process.exit(1);
}

console.log("=== #103692 msteams delivery-pipeline proof ===\n");

// ── Case 1: prose + tool-trace banner ──────────────────────────────
const mixed = "Done. The repo has been updated.\n⚠️ 🛠️ `search repos (agent)` failed";
const result1 = sanitizeText({ text: mixed, payload: { text: mixed } });
console.log("Case 1 — prose + tool-trace banner:");
console.log(`  Input:  ${JSON.stringify(mixed)}`);
console.log(`  Output: ${JSON.stringify(result1)}`);
console.log(`  VERDICT: ${result1 === "Done. The repo has been updated." ? "PASS" : "FAIL"}`);
console.log();

// ── Case 2: trace-only payload → suppressed ────────────────────────
const traceOnly = "⚠️ 🛠️ `run setup (agent)` failed";
const result2 = sanitizeText({ text: traceOnly, payload: { text: traceOnly } });
console.log("Case 2 — trace-only → empty (suppressed):");
console.log(`  Input:  ${JSON.stringify(traceOnly)}`);
console.log(`  Output: ${JSON.stringify(result2)}`);
console.log(`  VERDICT: ${result2 === "" ? "PASS" : "FAIL"}`);
console.log();

// ── Case 3: memory tags stripped ───────────────────────────────────
const withMemory = "Sure.\n<relevant_memories>\ncached\n</relevant_memories>";
const result3 = sanitizeText({ text: withMemory, payload: { text: withMemory } });
console.log("Case 3 — memory tags stripped:");
console.log(`  Input:  ${JSON.stringify(withMemory)}`);
console.log(`  Output: ${JSON.stringify(result3)}`);
console.log(`  VERDICT: ${result3 === "Sure." ? "PASS" : "FAIL"}`);
console.log();

// ── Case 4: clean prose passes through ─────────────────────────────
const clean = "The pipeline has 3 open deals.";
const result4 = sanitizeText({ text: clean, payload: { text: clean } });
console.log("Case 4 — clean prose passes through:");
console.log(`  Input:  ${JSON.stringify(clean)}`);
console.log(`  Output: ${JSON.stringify(result4)}`);
console.log(`  VERDICT: ${result4 === clean ? "PASS" : "FAIL"}`);
console.log();

const allPassed = result1 === "Done. The repo has been updated." &&
  result2 === "" &&
  result3 === "Sure." &&
  result4 === clean;

console.log(`\nOVERALL: ${allPassed ? "ALL PASSED" : "FAILURES"}`);
process.exit(allPassed ? 0 : 1);
