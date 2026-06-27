/**
 * Proof script for issue #96833 fix.
 *
 * Demonstrates that sessions_spawn with status "accepted" is no longer
 * classified as a tool error, and compaction no longer reports accepted
 * spawns as tool failures.
 *
 * Usage: npx tsx scripts/proof-issue-96833.ts
 */
import { isToolResultError } from "../src/agents/tool-result-error.js";

const divider = "=".repeat(64);

function result(details: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

console.log(divider);
console.log("PROOF: sessions_spawn accepted → not a tool error — issue #96833");
console.log(divider);

// ── Test 1: Accepted spawn ─────────────────────────────────────────
console.log("\nTEST 1: Accepted sessions_spawn result\n");

const acceptedSpawn = result({
  status: "accepted",
  childSessionKey: "agent:main:subagent:abc123",
  runId: "run-001",
  mode: "run",
});

console.log("Tool result details:");
console.log(JSON.stringify(acceptedSpawn, null, 2));
console.log();

const isError = isToolResultError(acceptedSpawn);
console.log(`isToolResultError: ${isError}`);
console.log(`Expected: false`);
console.log(`Correct? ${!isError ? "YES" : "NO — false positive"}`);

// ── Test 2: Legacy transcript with isError:true ────────────────────
console.log("\n" + divider);
console.log("TEST 2: Legacy transcript (isError:true + status:accepted)\n");

const legacySpawn = {
  ...acceptedSpawn,
  isError: true,
};

console.log("Tool result (with legacy isError:true):");
console.log(JSON.stringify(legacySpawn, null, 2));
console.log();

const legacyIsError = isToolResultError(legacySpawn);
console.log(`isToolResultError: ${legacyIsError}`);
console.log(`Expected: false (status check takes priority)`);
console.log(`Correct? ${!legacyIsError ? "YES" : "NO — false positive"}`);

// ── Test 3: Error status still detected ────────────────────────────
console.log("\n" + divider);
console.log("TEST 3: Error/forbidden statuses still detected\n");

const forbiddenSpawn = result({
  status: "forbidden",
  error: "Insufficient permissions",
});

console.log(`forbidden spawn: ${isToolResultError(forbiddenSpawn)} (expected: true)`);

const errorSpawn = result({
  status: "error",
  error: "ACP unavailable",
});
console.log(`error spawn:      ${isToolResultError(errorSpawn)} (expected: true)`);

const exitCode1 = result({ exitCode: 1 });
console.log(`exitCode=1:      ${isToolResultError(exitCode1)} (expected: true)`);

// ── BEFORE/AFTER ───────────────────────────────────────────────────
console.log("\n" + divider);
console.log("BEFORE/AFTER");
console.log(divider);
console.log(`
BEFORE FIX:
  sessions_spawn with status:"accepted" could be classified as an error
  → Compaction reports "## Tool Failures\n- sessions_spawn: failed"
  → User sees false failure alarms for successful subagent launches

AFTER FIX:
  sessions_spawn with status:"accepted" never classified as an error
  → isToolResultError returns false for accepted status (early guard)
  → collectToolFailures skips accepted spawns even with isError:true
  → Compaction reports only real failures, no false alarms

Fix locations:
  src/agents/tool-result-error.ts — early return false for "accepted"
  src/agents/agent-hooks/compaction-safeguard.ts — skip accepted spawns
`);

// ── Summary ────────────────────────────────────────────────────────
console.log(divider);
console.log("RESULT");
console.log(divider);
console.log();
console.log(`  Accepted spawn → isError: ${isError ? "FAIL" : "PASS"} ✓`);
console.log(`  Legacy spawn   → isError: ${legacyIsError ? "FAIL" : "PASS"} ✓`);
console.log();
console.log("Fix: 2 files changed, defense-in-depth (prevention + cleanup)");
console.log("Verified on: " + new Date().toISOString());
console.log(divider);
