// Verify that bootstrapMaxChars and bootstrapTotalMaxChars survive config operations.
//
// Usage:
//   pnpm tsx scripts/repro/issue-96240-bootstrap-proof.mts

import { stripUnknownConfigKeys } from "../../src/commands/doctor-config-analysis.js";
import { assertGatewayConfigMutationAllowedForTest } from "../../src/agents/tools/gateway-tool.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed += 1;
  } else {
    console.log(`  ❌ ${label}`);
    failed += 1;
  }
}

function assertDoesNotThrow(fn: () => void, label: string): void {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed += 1;
  } catch {
    console.log(`  ❌ ${label} (unexpected throw)`);
    failed += 1;
  }
}

// ── Test 1: stripUnknownConfigKeys preserves agents.defaults.bootstrapMaxChars ──
console.log("\n── Test 1: stripUnknownConfigKeys preserves agents.defaults.bootstrapMaxChars ──");
const stripResult = stripUnknownConfigKeys({
  agents: { defaults: { bootstrapMaxChars: 50000, bootstrapTotalMaxChars: 150000, badKey: true } },
} as never);

assert(stripResult.removed.includes("agents.defaults.badKey"), "strips badKey");
assert(!stripResult.removed.includes("agents.defaults.bootstrapMaxChars"), "preserves bootstrapMaxChars");
assert(!stripResult.removed.includes("agents.defaults.bootstrapTotalMaxChars"), "preserves bootstrapTotalMaxChars");
const defaults = (stripResult.config as Record<string, Record<string, Record<string, unknown>>>).agents?.defaults;
assert(defaults?.bootstrapMaxChars === 50000, "bootstrapMaxChars value retained");
assert(defaults?.bootstrapTotalMaxChars === 150000, "bootstrapTotalMaxChars value retained");
assert(!("badKey" in defaults), "badKey removed from result");

// ── Test 2: assertGatewayConfigMutationAllowed allows bootstrapMaxChars via config.patch ──
console.log("\n── Test 2: config.patch allows bootstrapMaxChars change ──");
assertDoesNotThrow(
  () =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.patch",
      currentConfig: { agents: { defaults: { bootstrapMaxChars: 20000 } } },
      raw: JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 50000 } } }),
    }),
  "config.patch bootstrapMaxChars: was allowed",
);

// ── Test 3: assertGatewayConfigMutationAllowed allows bootstrapTotalMaxChars via config.patch ──
console.log("\n── Test 3: config.patch allows bootstrapTotalMaxChars change ──");
assertDoesNotThrow(
  () =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.patch",
      currentConfig: { agents: { defaults: { bootstrapTotalMaxChars: 60000 } } },
      raw: JSON.stringify({ agents: { defaults: { bootstrapTotalMaxChars: 150000 } } }),
    }),
  "config.patch bootstrapTotalMaxChars: was allowed",
);

// ── Test 4: assertGatewayConfigMutationAllowed allows bootstrapMaxChars via config.apply ──
console.log("\n── Test 4: config.apply allows bootstrapMaxChars change ──");
assertDoesNotThrow(
  () =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.apply",
      currentConfig: { agents: { defaults: { bootstrapMaxChars: 20000 } } },
      raw: JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 50000 } } }),
    }),
  "config.apply bootstrapMaxChars: was allowed",
);

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n── Result: ${passed} passed, ${failed} failed ──`);
if (failed > 0) {
  process.exit(1);
}
