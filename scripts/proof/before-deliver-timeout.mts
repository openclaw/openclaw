/**
 * Lane-recovery proof for #103733: createReplyDispatcher with a hung
 * beforeDeliver hook recovers after timeout — waitForIdle() settles
 * and a follow-up message sent through a separate dispatcher is
 * delivered.
 *
 * Usage: node --import tsx scripts/proof/before-deliver-timeout.mts
 */
import { createReplyDispatcher } from "../../src/auto-reply/reply/reply-dispatcher.js";

async function main() {
  console.log("=== #103733 lane recovery proof ===\n");

  const delivered: string[] = [];
  let hung = false;

  const hungDispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload.text ?? "");
    },
    beforeDeliverTimeoutMs: 2_000,
    beforeDeliver: async () => {
      // Simulates the WhatsApp hook from #103684: never settles.
      hung = true;
      await new Promise<never>(() => {
        /* hangs */
      });
      return null;
    },
  });

  // Scenario: hung hook blocks the lane.
  console.log("── Scenario: hung beforeDeliver → timeout → lane recovery ──");
  hungDispatcher.sendFinalReply({ text: "Real reply" });
  hungDispatcher.markComplete();

  const start = Date.now();
  await hungDispatcher.waitForIdle();
  const recoveryMs = Date.now() - start;

  const cancelled = hungDispatcher.getCancelledCounts?.()?.final ?? 0;

  // After lane recovery, a clean dispatcher must deliver normally.
  const cleanDispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload.text ?? "");
    },
  });
  cleanDispatcher.sendFinalReply({ text: "Follow-up message after recovery" });
  cleanDispatcher.markComplete();
  await cleanDispatcher.waitForIdle();

  console.log(`  Hook hung:        ${hung}`);
  console.log(`  waitForIdle:      ${recoveryMs < 10_000} (${recoveryMs}ms)`);
  console.log(`  Cancelled count:  ${cancelled} (Real reply)`);
  console.log(`  Delivered count:  ${delivered.length}`);
  console.log(`  Delivered:        ${JSON.stringify(delivered)}`);

  const ok =
    recoveryMs < 10_000 &&
    cancelled === 1 &&
    delivered.length === 1 &&
    delivered[0] === "Follow-up message after recovery";

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
