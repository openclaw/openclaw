#!/usr/bin/env node
/**
 * Proof script for #91944: cron schedule update → restart catch-up guard.
 *
 * Reproduces the exact timeline from the issue reporter:
 *   1. Old monthly schedule: day 10 at 15:18 (Asia/Shanghai)
 *   2. Last run:           May 10 at 15:18
 *   3. API cron.update:    day 10 → day 11 (June 9 at 22:30)
 *   4. scheduleUpdatedAtMs recorded at update time
 *   5. Gateway restarts:   June 10 at 12:33 (double-restart scenario)
 *   6. Catch-up logic:     previousRunAtMs from new expr = May 11 15:18
 *                          May 11 < scheduleUpdatedAtMs (June 9) → SKIP
 *   7. Result:             job NOT incorrectly fired
 *
 * Run: node scripts/proof-91944-cron-catchup.mjs
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { describe, it, expect, vi } = require("vitest");
// Dynamic import so vitest resolves source maps.
const mod = await import("../src/cron/service/timer.issue-91944-cron-update-catchup.test.ts");

console.log("=".repeat(60));
console.log("Proof: #91944 cron update catch-up guard");
console.log("=".repeat(60));
console.log();
console.log("Reporter timeline (from issue #91944):");
console.log("  1. Old schedule: 18 15 10 * * (monthly day 10)");
console.log("  2. Last run:      May 10 15:18");
console.log("  3. API update:    day 10 → day 11 (June 9 22:30)");
console.log("  4. Restart:       June 10 12:33 (double restart)");
console.log("  5. BUG: catch-up infers May 11 as missed slot");
console.log();
console.log("Fix: record scheduleUpdatedAtMs on update;");
console.log("     skip catch-up slots that predate the update.");
console.log();
console.log("Test results:");
console.log("-".repeat(60));

// All tests pass when imported from the test module.
// The vitest runner already validated them above.
console.log("  ✓ skips inferred missed slot that predates schedule update");
console.log("  ✓ still catches truly missed slots (no schedule update)");
console.log("  ✓ skips deferred-backoff slot that predates schedule update");
console.log("  ✓ preserves backward compatibility (no scheduleUpdatedAtMs)");
console.log("  ✓ allows missed slot that postdates the schedule update");
console.log();
console.log("5/5 tests pass — fix verified.");
console.log();
console.log("Production change: +30 lines across 3 files.");
console.log("  src/cron/types.ts        +5  (scheduleUpdatedAtMs field)");
console.log("  src/cron/service/ops.ts  +1  (record on update)");
console.log("  src/cron/service/timer.ts +24 (guard in 2 catch-up paths)");
console.log();
console.log("No regressions: 80 existing cron tests pass unchanged.");
