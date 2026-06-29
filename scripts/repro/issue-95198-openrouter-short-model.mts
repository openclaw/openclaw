#!/usr/bin/env node
/**
 * Live repro for issue #95198: OpenRouter short model IDs get double-prefixed.
 *
 * Verifies that `openrouter/deepseek-v4-flash` resolves to the upstream API
 * model ID `deepseek/deepseek-v4-flash` instead of the broken
 * `openrouter/openrouter/deepseek-v4-flash`.
 */
import { normalizeOpenRouterApiModelId } from "../../extensions/openrouter/models.js";

const cases = [
  { input: "openrouter/deepseek-v4-flash", expected: "deepseek/deepseek-v4-flash" },
  { input: "openrouter/deepseek-v4-pro", expected: "deepseek/deepseek-v4-pro" },
  { input: "openrouter/deepseek/deepseek-v4-flash", expected: "deepseek/deepseek-v4-flash" },
  { input: "openrouter/auto", expected: "openrouter/auto" },
  { input: "openrouter/free", expected: "openrouter/free" },
  { input: "deepseek/deepseek-v4-flash", expected: "deepseek/deepseek-v4-flash" },
];

let failed = false;
console.log("=== Reproduction for issue #95198 ===");
for (const { input, expected } of cases) {
  const actual = normalizeOpenRouterApiModelId(input);
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"}: ${input} -> ${actual} (expected ${expected})`);
  if (!pass) {
    failed = true;
  }
}

if (failed) {
  console.error("\nFAIL: one or more OpenRouter model ID normalizations are incorrect.");
  process.exitCode = 1;
} else {
  console.log("\nPASS: short OpenRouter model IDs resolve to the correct upstream slugs.");
}
