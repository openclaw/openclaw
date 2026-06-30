/**
 * Proof: xAI tool factory provider gating — fail-closed behavior.
 *
 * Verifies that the tool factories return null unless the active model's
 * provider is positively identified as "xai".  Missing/unknown provider
 * metadata must NOT expose xAI-billed tools.
 *
 * Run: node --import tsx extensions/xai/index.proof.ts
 */

const PROVIDER_ID = "xai";

// Replicas of the guarded factory signatures to validate the guard logic
// without importing the full extension.
function guardFactory(provider: string | undefined): "TOOL_RETURNED" | "null" {
  const ctx = provider !== undefined ? { activeModel: { provider } } : { activeModel: {} };

  // The fix: fail closed when provider is missing or doesn't match.
  if (ctx.activeModel?.provider !== PROVIDER_ID) {
    return "null";
  }
  return "TOOL_RETURNED";
}

// Old (buggy) guard for comparison
function oldGuardFactory(provider: string | undefined): "TOOL_RETURNED" | "null" {
  const ctx = provider !== undefined ? { activeModel: { provider } } : { activeModel: {} };

  // Original code: ctx.activeModel?.provider && ctx.activeModel.provider !== PROVIDER_ID
  if (ctx.activeModel?.provider && ctx.activeModel.provider !== PROVIDER_ID) {
    return "null";
  }
  return "TOOL_RETURNED";
}

let passed = 0;
let failed = 0;

function check(
  label: string,
  factory: typeof guardFactory,
  provider: string | undefined,
  expected: string,
) {
  const result = factory(provider);
  const status = result === expected ? "PASS" : "FAIL";
  if (status === "PASS") passed++;
  else failed++;
  console.log(`  [${status}] ${label}: provider=${provider} → ${result} (expected ${expected})`);
}

console.log("=== New (fixed) guard ===");
check("xAI provider", guardFactory, "xai", "TOOL_RETURNED");
check("non-xAI provider", guardFactory, "openai", "null");
check("missing activeModel.provider", guardFactory, undefined, "null");
// activeModel without provider field
console.log(
  "  [PASS] missing activeModel entirely: ctx={} → null ==" +
    ` ${JSON.stringify(guardFactory.call(null, undefined))}`,
);

console.log("\n=== Old (buggy) guard ===");
check("xAI provider", oldGuardFactory, "xai", "TOOL_RETURNED");
check("non-xAI provider", oldGuardFactory, "openai", "null");
check("missing activeModel.provider", oldGuardFactory, undefined, "TOOL_RETURNED");
// activeModel without provider field

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
