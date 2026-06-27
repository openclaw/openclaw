/**
 * Proof script for issue #96588 fix.
 *
 * Demonstrates that model alias resolution uses numeric-aware
 * localeCompare so that "opus-4-10" sorts above "opus-4-9".
 *
 * Usage: npx tsx scripts/proof-issue-96588.ts
 */
import { parseModelPattern } from "../src/agents/sessions/model-resolver.js";
import type { Model } from "../src/llm/types.js";

const divider = "=".repeat(64);

function model(provider: string, id: string): Model {
  return {
    id,
    name: id,
    api: "openai-responses" as const,
    provider,
    baseUrl: `https://${provider}.example.test`,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

console.log(divider);
console.log("PROOF: Numeric-aware model alias resolution — issue #96588");
console.log(divider);

const models = [model("anthropic", "claude-opus-4-9"), model("anthropic", "claude-opus-4-10")];

console.log("\nAvailable models:");
for (const m of models) {
  console.log(`  ${m.provider}/${m.id}`);
}

// ── Core test ─────────────────────────────────────────────────────
console.log(`\nAlias requested: "opus"`);

const result = parseModelPattern("opus", models);

console.log(`Resolver picked: ${result.model?.id}`);

const correct = result.model?.id === "claude-opus-4-10";
console.log(`Expected (numerically newest): claude-opus-4-10`);
console.log(`Correct? ${correct ? "YES" : "NO — older version selected"}`);

// ── Before/After comparison ───────────────────────────────────────
console.log("\n" + divider);
console.log("BEFORE/AFTER");
console.log(divider);

console.log(`
BEFORE FIX (plain localeCompare, no numeric option):
  Sort order: "claude-opus-4-9" > "claude-opus-4-10" (lexicographic)
  Resolver picks: claude-opus-4-9  ← WRONG (older version)
  Why: '9' > '1' in character code order

AFTER FIX (localeCompare with { numeric: true }):
  Sort order: "claude-opus-4-10" > "claude-opus-4-9" (numeric)
  Resolver picks: claude-opus-4-10 ← CORRECT (newest version)
  Why: 10 > 9 in numeric order
`);

// ── Summary ────────────────────────────────────────────────────────
console.log(divider);
console.log("RESULT");
console.log(divider);
console.log();
console.log(`  Picked:   ${result.model?.id}`);
console.log(`  Expected: claude-opus-4-10`);
console.log(`  Status:   ${correct ? "✓ PASS" : "✗ FAIL"}`);
console.log();
console.log("Fix: added { numeric: true } to localeCompare sort comparators");
console.log("File: src/agents/sessions/model-resolver.ts lines 119, 123");
console.log("Verified on: " + new Date().toISOString());
console.log(divider);
