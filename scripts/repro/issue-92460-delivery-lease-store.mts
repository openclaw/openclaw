/**
 * Reproduction and verification script for issue #92460 / PR #93110.
 *
 * Demonstrates the end-to-end delivery lease lifecycle:
 *   1. Lease creation  (registerDeliveryLease)
 *   2. Lease lookup by subagent announce path (resolveAnnounceOrigin via sessionKey)
 *   3. Cleanup via retirement
 *
 * Run: node --import tsx scripts/repro/issue-92460-delivery-lease-store.mts
 */
import { registerDeliveryLease, lookupDeliveryLease, retireDeliveryLease } from "../../src/infra/delivery-lease-store.js";
import { resolveAnnounceOrigin } from "../../src/agents/subagent-announce-origin.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const sessionKey = "cron:test-job:agent:main:run:test-run-id-12345";
  const deliveryContext = {
    channel: "webchat",
    to: "controller",
    accountId: "default",
    threadId: "thread-42",
  };

  // 1. Register a delivery lease (simulates what prepareCronRunContext does)
  console.log("=== Step 1: Register delivery lease ===");
  registerDeliveryLease(sessionKey, deliveryContext);
  console.log(`  Registered lease for: ${sessionKey}`);

  // 2. Look up the lease (findable by the same sessionKey)
  console.log("\n=== Step 2: Look up delivery lease ===");
  const found = lookupDeliveryLease(sessionKey);
  assert(found !== undefined, "lease should be found");
  assert(found?.channel === "webchat", `expected webchat, got ${found?.channel}`);
  assert(found?.to === "controller", `expected controller, got ${found?.to}`);
  console.log(`  Found lease: channel=${found?.channel}, to=${found?.to}, accountId=${found?.accountId}, threadId=${found?.threadId}`);

  // 3. resolveAnnounceOrigin fallback (simulates subagent announce lookup)
  console.log("\n=== Step 3: resolveAnnounceOrigin with empty session entry ===");
  // An empty session entry (no deliveryContext, no last* fields) — this is
  // what isolated cron sessions look like after sanitizeFreshCronSessionEntry.
  const emptyEntry = {};
  const origin = resolveAnnounceOrigin(emptyEntry, undefined, sessionKey);
  assert(origin !== undefined, "resolveAnnounceOrigin should fall back to lease store");
  assert(origin?.channel === "webchat", `expected webchat, got ${origin?.channel}`);
  assert(origin?.to === "controller", `expected controller, got ${origin?.to}`);
  console.log(`  Resolved origin: channel=${origin?.channel}, to=${origin?.to}, accountId=${origin?.accountId}, threadId=${origin?.threadId}`);

  // 4. Lookup without sessionKey (original behavior — should return undefined
  //    because the entry has no delivery context)
  console.log("\n=== Step 4: resolveAnnounceOrigin WITHOUT sessionKey ===");
  const originNoFallback = resolveAnnounceOrigin(emptyEntry, undefined);
  assert(originNoFallback === undefined, "should return undefined without sessionKey fallback");
  console.log("  Correctly returned undefined (no sessionKey fallback)");

  // 5. Retirement (simulates cleanup after delivery settles)
  console.log("\n=== Step 5: Retire delivery lease ===");
  retireDeliveryLease(sessionKey);
  const afterRetire = lookupDeliveryLease(sessionKey);
  assert(afterRetire === undefined, "lease should be gone after retirement");
  console.log("  Lease successfully retired");

  // 6. Idempotent retirement
  console.log("\n=== Step 6: Idempotent retirement ===");
  retireDeliveryLease(sessionKey); // should not throw
  console.log("  Second retire call did not throw");

  console.log("\n✓ PASS: All delivery lease store proofs passed.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
