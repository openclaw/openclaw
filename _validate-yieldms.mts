/**
 * Proof script for #105930: execSchema.yieldMs Type.Number → Type.Integer({ minimum: 0 })
 *
 * Validates the actual production schema exported from bash-tools.schemas.ts.
 * Run: npx tsx _validate-yieldms.mts
 */

import { Value } from "typebox/value";
import { execSchema } from "./src/agents/bash-tools.schemas.js";

console.log("=== execSchema.yieldMs (production, Integer({ minimum: 0 })) ===\n");

const cases: Array<{ label: string; input: Record<string, unknown>; expect: boolean }> = [
  {
    label: "valid integer yieldMs",
    input: { command: "echo hi", yieldMs: 10000 },
    expect: true,
  },
  {
    label: "yieldMs=0 (min boundary)",
    input: { command: "echo hi", yieldMs: 0 },
    expect: true,
  },
  {
    label: "float yieldMs — rejected",
    input: { command: "echo hi", yieldMs: 10.5 },
    expect: false,
  },
  {
    label: "negative yieldMs — rejected",
    input: { command: "echo hi", yieldMs: -100 },
    expect: false,
  },
  {
    label: "yieldMs omitted (optional)",
    input: { command: "echo hi" },
    expect: true,
  },
  {
    label: "yieldMs with background flag",
    input: { command: "long-task", yieldMs: 5000, background: true },
    expect: true,
  },
];

let passed = 0;
let failed = 0;

for (const { label, input, expect: expected } of cases) {
  const result = Value.Check(execSchema, input);
  const marker = result === expected ? "✓" : "✗";
  if (result === expected) {
    passed++;
    console.log(`  ${marker} ${label}: ${JSON.stringify(input)} → ${result}`);
  } else {
    failed++;
    console.log(`  ${marker} ${label}: ${JSON.stringify(input)} → ${result} (expected ${expected})`);
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
