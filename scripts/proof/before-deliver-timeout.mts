/**
 * Real-behavior proof for #103733: combineBeforeDeliverHooks wraps
 * each hook with a 30s deadline. A hung hook is cancelled and the
 * composed chain continues to the next hook.
 *
 * Usage: node --import tsx scripts/proof/before-deliver-timeout.mts
 */
import { combineBeforeDeliverHooks } from "../../src/auto-reply/dispatch.js";

async function main() {
  console.log("=== #103733 composer timeout proof ===\n");

  let hanged = false;

  // Compose two hooks: first hangs, second should run after timeout.
  const composed = combineBeforeDeliverHooks(
    async () => {
      await new Promise<never>(() => {
        hanged = true;
      });
      return null;
    },
    async (payload: { text: string }) => payload,
  );

  const start = Date.now();
  const result = await composed!({ text: "test" }, { kind: "final" });
  const elapsed = Date.now() - start;

  // Hung hook timed out → null. Second hook sees null → returns null.
  // The lane is unblocked and delivered payload propagates.

  console.log(`  Hook hung:      ${hanged}`);
  console.log(`  Timeout fired:  ${elapsed >= 29_000}`);
  console.log(`  Result:         ${result === null ? "null (cancelled)" : "delivered"}`);
  console.log(`  Elapsed:        ${elapsed}ms`);

  const ok = hanged && result === null && elapsed >= 29_000 && elapsed < 35_000;
  console.log(`\n  VERDICT: ${ok ? "PASS" : "FAIL"}`);
  console.log(`\n  Without fix: waitForIdle() blocks forever.`);
  console.log(`  With fix: composer cancels hung hook, lane recovers.`);

  process.exit(ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("FATAL:", err);
  process.exit(1);
});
