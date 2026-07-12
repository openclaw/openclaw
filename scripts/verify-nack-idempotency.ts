/**
 * Real-behavior verification for nack() idempotency guard.
 *
 * Runs the production receive module through the tsx loader to prove:
 * 1. Duplicate sequential nack calls invoke onNack only once.
 * 2. A rejected onNack callback leaves the context retryable.
 * 3. The ack-to-nack transition is preserved.
 *
 * Usage: node --import tsx scripts/verify-nack-idempotency.ts
 */
import { createMessageReceiveContext } from "../src/channels/message/receive.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    console.error(`  \x1b[31m✗ FAIL\x1b[0m: ${label}`);
  }
}

async function main() {
  console.log("\n=== nack() idempotency real-behavior verification ===\n");

  // ── Test 1: duplicate sequential nack ──
  console.log("Test 1: Duplicate sequential nack calls onNack only once");
  {
    let callCount = 0;
    const ctx = createMessageReceiveContext({
      id: "real-1",
      channel: "telegram",
      message: { text: "hello" },
      onNack: async () => {
        callCount += 1;
      },
    });

    await ctx.nack(new Error("first"));
    assert(callCount === 1, "onNack called once after first nack");
    assert(ctx.ackState === "nacked", "ackState is 'nacked'");
    assert(ctx.nackErrorMessage === "first", "nackErrorMessage preserved");

    await ctx.nack(new Error("second"));
    assert(callCount === 1, "onNack still called only once after duplicate nack");
    assert(ctx.ackState === "nacked", "ackState remains 'nacked'");
    assert(ctx.nackErrorMessage === "first", "first error message preserved");
  }

  // ── Test 2: rejected callback remains retryable ──
  console.log("\nTest 2: Rejected onNack callback leaves context retryable");
  {
    let attempts = 0;
    const ctx = createMessageReceiveContext({
      id: "real-2",
      channel: "telegram",
      message: { text: "hello" },
      onNack: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient nack failure");
        }
      },
    });

    await ctx.nack(new Error("receive failed")).catch(() => {});
    assert(attempts === 1, "onNack called once (first attempt rejected)");
    assert(ctx.ackState === "pending", "ackState stays 'pending' after rejection");
    assert(ctx.nackErrorMessage === undefined, "nackErrorMessage not set after rejection");

    await ctx.nack(new Error("receive failed"));
    assert(attempts === 2, "onNack called again on retry");
    assert(ctx.ackState === "nacked", "ackState transitions to 'nacked' after success");
    assert(ctx.nackErrorMessage === "receive failed", "nackErrorMessage set after success");
  }

  // ── Test 3: ack-to-nack transition preserved ──
  console.log("\nTest 3: ack-to-nack transition preserved");
  {
    let nackCalls = 0;
    const ctx = createMessageReceiveContext({
      id: "real-3",
      channel: "telegram",
      message: { text: "hello" },
      onAck: async () => {},
      onNack: async () => {
        nackCalls += 1;
      },
    });

    await ctx.ack();
    assert(ctx.ackState === "acked", "ackState is 'acked' after ack()");

    await ctx.nack(new Error("post-ack failure"));
    assert(nackCalls === 1, "onNack called once after ack-to-nack transition");
    assert(ctx.ackState === "nacked", "ackState transitions to 'nacked' from 'acked'");
    assert(ctx.nackErrorMessage === "post-ack failure", "nackErrorMessage set");
  }

  // ── Summary ──
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("Verification error:", err);
  process.exit(1);
});
