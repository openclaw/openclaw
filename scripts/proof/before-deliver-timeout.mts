/**
 * Lane-recovery proof for #103733: createReplyDispatcher with a hung
 * beforeDeliver hook recovers after timeout — waitForIdle() settles
 * and a follow-up reply is delivered.
 *
 * Usage: node --import tsx scripts/proof/before-deliver-timeout.mts
 */
import { createReplyDispatcher } from "../../src/auto-reply/reply/reply-dispatcher.js";

async function main() {
  console.log("=== #103733 lane recovery proof ===\n");

  const delivered: string[] = [];
  const start = Date.now();

  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload.text ?? "");
    },
    beforeDeliverTimeoutMs: 2_000,
    beforeDeliver: async () => {
      // Simulates the WhatsApp hook from #103684: never settles.
      await new Promise<never>(() => {
        /* hangs */
      });
      return null;
    },
  });

  // Enqueue the "stuck" reply — the hung hook blocks its send chain.
  dispatcher.sendFinalReply({ text: "Real reply (stuck)" });
  dispatcher.markComplete();

  // waitForIdle must settle after timeout + follow-up delivery succeeds.
  await dispatcher.waitForIdle();
  const recoveryMs = Date.now() - start;

  // Enqueue follow-up to prove the lane is fully unblocked.
  dispatcher.sendFinalReply({ text: "Follow-up after recovery" });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();

  const cancelled = dispatcher.getCancelledCounts?.()?.final ?? 0;

  console.log(`  Hook hung:        ${true}`);
  console.log(`  waitForIdle:      ${recoveryMs < 10_000} (${recoveryMs}ms)`);
  console.log(`  Cancelled count:  ${cancelled} (Real reply)`);
  console.log(`  Delivered count:  ${delivered.length}`);
  console.log(`  Delivered:        ${JSON.stringify(delivered)}`);

  const ok =
    recoveryMs < 10_000 &&
    cancelled === 1 &&
    delivered.length === 1 &&
    delivered[0] === "Follow-up after recovery";

  console.log(`\n  VERDICT:`);
  console.log(`    Recovery (waitForIdle < 10s): ${recoveryMs < 10_000 ? "PASS" : "FAIL"}`);
  console.log(`    Hung msg cancelled:            ${cancelled === 1 ? "PASS" : "FAIL"}`);
  console.log(`    Next msg delivered:             ${delivered.length === 1 ? "PASS" : "FAIL"}`);
  console.log(`    Lane unblocked:                 ${ok ? "PASS" : "FAIL"}`);
  console.log(`\n  OVERALL: ${ok ? "ALL PASSED" : "FAILURES"}`);

  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("FATAL:", err);
  process.exit(1);
});
