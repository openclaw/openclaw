/**
 * Proof script for issue #104903 fix.
 *
 * Demonstrates that nack() is now idempotent — duplicate calls
 * are no-ops and onNack fires only once.
 *
 * Usage: npx tsx scripts/proof-issue-104903.ts
 */
import { createMessageReceiveContext } from "../src/channels/message/receive.js";

const divider = "=".repeat(64);
let exitCode = 0;

function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) {
    exitCode = 1;
  }
}

console.log(divider);
console.log("PROOF: nack() idempotency guard — issue #104903");
console.log(divider);

// ── Test: duplicate nack calls ──────────────────────────────────────
console.log("\n--- Duplicate nack calls ---\n");

let nackCount = 0;
const ctx = createMessageReceiveContext({
  id: "test",
  channel: "test",
  message: {},
  onNack: () => {
    nackCount++;
  },
});

await ctx.nack(new Error("first error"));
console.log("  First nack:  onNack called");
await ctx.nack(new Error("second error - should be ignored"));
console.log("  Second nack: no-op (guard prevented onNack)");

console.log();
check(nackCount === 1, `onNack called exactly once (${nackCount})`);
check(ctx.ackState === "nacked", `ackState is "nacked"`);
check(ctx.nackErrorMessage?.includes("first error") ?? false, "first error message preserved");

// ── BEFORE/AFTER ───────────────────────────────────────────────────
console.log("\n" + divider);
console.log("BEFORE/AFTER");
console.log(divider);
console.log(`
BEFORE FIX:
  nack: async (error) => {
    await params.onNack?.(error);    // Fires every call
    ctx.ackState = "nacked";
    ctx.nackErrorMessage = normalizeAckErrorMessage(error);
  },
  → Duplicate calls re-fire onNack and overwrite nackErrorMessage

AFTER FIX:
  nack: async (error) => {
    if (ctx.ackState !== "pending") { return; }  // Idempotent guard
    await params.onNack?.(error);
    ctx.ackState = "nacked";
    ctx.nackErrorMessage = normalizeAckErrorMessage(error);
  },
  → Duplicate calls are no-ops, matching ack() behavior
`);

console.log(divider);
console.log("RESULT");
console.log(divider);
if (exitCode === 0) {
  console.log("  ALL CHECKS PASSED ✓");
} else {
  console.log("  SOME CHECKS FAILED ✗");
}
console.log();
console.log("Fix:  src/channels/message/receive.ts (+4 lines)");
console.log("Test: src/channels/message/receive.test.ts (5 tests)");
console.log("Verified on: " + new Date().toISOString());
console.log(divider);
process.exit(exitCode);
