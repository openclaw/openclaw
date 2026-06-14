import { resolveTokenThreshold } from "../src/config/token-threshold.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ PASS: ${message}`);
  }
}

function main() {
  console.log("=== Compaction Percentage Token Threshold Proof ===\n");

  // 1. Percentage string resolution
  console.log("1. Percentage string resolution against context window");
  assert(
    resolveTokenThreshold("40%", 1_000_000, 4_000) === 400_000,
    '"40%" with 1M context → 400000',
  );
  assert(
    resolveTokenThreshold("40%", 200_000, 4_000) === 80_000,
    '"40%" with 200K context → 80000 (correctly scaled)',
  );
  assert(
    resolveTokenThreshold("10%", 128_000, 20_000) === 12_800,
    '"10%" with 128K context → 12800',
  );
  assert(
    resolveTokenThreshold("75%", 256_000, 4_000) === 192_000,
    '"75%" with 256K context → 192000',
  );

  // 2. Numeric pass-through (backward compatibility)
  console.log("\n2. Numeric pass-through (backward compatible)");
  assert(
    resolveTokenThreshold(400_000, 1_000_000, 4_000) === 400_000,
    "400000 int with 1M context → 400000 (unchanged)",
  );
  assert(
    resolveTokenThreshold(80_000, 200_000, 4_000) === 80_000,
    "80000 int with 200K context → 80000 (unchanged)",
  );
  assert(resolveTokenThreshold(0, 1_000_000, 4_000) === 0, "0 int → 0 (edge case)");

  // 3. Undefined falls back to default
  console.log("\n3. Undefined falls back to default");
  assert(
    resolveTokenThreshold(undefined, 1_000_000, 4_000) === 4_000,
    "undefined with default 4000 → 4000",
  );
  assert(
    resolveTokenThreshold(undefined, 200_000, 20_000) === 20_000,
    "undefined with default 20000 → 20000",
  );

  // 4. Invalid strings fall back to default
  console.log("\n4. Invalid strings fall back to default");
  assert(
    resolveTokenThreshold("not-a-percent", 1_000_000, 4_000) === 4_000,
    "invalid string 'not-a-percent' → default 4000",
  );
  assert(
    resolveTokenThreshold("40.5%", 1_000_000, 4_000) === 4_000,
    "invalid string '40.5%' (decimal) → default 4000",
  );
  assert(
    resolveTokenThreshold("abc", 1_000_000, 4_000) === 4_000,
    "invalid string 'abc' → default 4000",
  );
  assert(resolveTokenThreshold("", 1_000_000, 4_000) === 4_000, "empty string → default 4000");

  // 5. Model-switch scaling scenario (the core use case)
  console.log("\n5. Model-switch scaling scenario");
  const softThresholdConfig = "40%";
  const deepseekContext = 1_000_000;
  const glmContext = 200_000;

  const deepseekTokens = resolveTokenThreshold(softThresholdConfig, deepseekContext, 4_000);
  const glmTokens = resolveTokenThreshold(softThresholdConfig, glmContext, 4_000);

  assert(deepseekTokens === 400_000, `DeepSeek 1M + "40%" → ${deepseekTokens} (40% of 1M)`);
  assert(glmTokens === 80_000, `GLM 200K + "40%" → ${glmTokens} (40% of 200K)`);
  assert(
    deepseekTokens === glmTokens * 5,
    "DeepSeek threshold = 5x GLM threshold for same percentage",
  );

  console.log("\n=== All checks complete ===");
}

main();
