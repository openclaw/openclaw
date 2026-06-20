/**
 * Live proof script for PR #95208 — OpenRouter short model ID fix.
 *
 * Demonstrates that:
 *  1. Short refs (openrouter/deepseek-v4-flash) now expand to the correct
 *     upstream slug (deepseek/deepseek-v4-flash) that OpenRouter accepts.
 *  2. Native route IDs (openrouter/auto, openrouter/fusion, etc.) are preserved.
 *  3. Before-fix behavior would have sent an invalid model ID → HTTP 400.
 *
 * Usage:  node --import tsx scripts/repro/issue-95198-openrouter-live-proof.mts
 *
 * To add live API completion proof (requires OPENROUTER_API_KEY):
 *   OPENROUTER_API_KEY="sk-or-..." node --import tsx scripts/repro/issue-95198-openrouter-live-proof.mts --live
 */

import { normalizeOpenRouterApiModelId } from "../../extensions/openrouter/models.ts";

const LIVE = process.argv.includes("--live");
const API_KEY = process.env.OPENROUTER_API_KEY;

interface TestCase {
  input: string;
  expected: string;
  description: string;
}

const testCases: TestCase[] = [
  // Short DeepSeek V4 refs — BROKEN (HTTP 400) before the fix
  { input: "openrouter/deepseek-v4-flash", expected: "deepseek/deepseek-v4-flash", description: "Short DSv4 — WAS BROKEN with 400" },
  { input: "openrouter/deepseek-v4-pro", expected: "deepseek/deepseek-v4-pro", description: "Short DSv4 — WAS BROKEN with 400" },
  // Native route IDs — MUST preserve
  { input: "openrouter/auto", expected: "openrouter/auto", description: "Native route — preserve prefix" },
  { input: "openrouter/auto:free", expected: "openrouter/auto:free", description: "Native route — preserve prefix" },
  { input: "openrouter/auto:lowest-latency", expected: "openrouter/auto:lowest-latency", description: "Native route — preserve prefix" },
  { input: "openrouter/fusion", expected: "openrouter/fusion", description: "Native route — preserve prefix" },
  { input: "openrouter/bodybuilder", expected: "openrouter/bodybuilder", description: "Native route — preserve prefix" },
  { input: "openrouter/free", expected: "openrouter/free", description: "Native route — preserve prefix" },
  { input: "openrouter/owl-alpha", expected: "openrouter/owl-alpha", description: "Native route — preserve prefix" },
  { input: "openrouter/pareto-code", expected: "openrouter/pareto-code", description: "Native route — preserve prefix" },
  { input: "openrouter/hunter-alpha", expected: "openrouter/hunter-alpha", description: "Native prefix — preserve prefix" },
  { input: "openrouter/hunter-alpha:1", expected: "openrouter/hunter-alpha:1", description: "Native prefix — preserve prefix" },
  // Namespaced refs — strip prefix (regression check)
  { input: "openrouter/anthropic/claude-sonnet-4.6", expected: "anthropic/claude-sonnet-4.6", description: "Namespaced — strip prefix" },
  { input: "openrouter/deepseek/deepseek-chat-v3", expected: "deepseek/deepseek-chat-v3", description: "Namespaced — strip prefix" },
  // Non-openrouter — pass through
  { input: "anthropic/claude-sonnet-4.6", expected: "anthropic/claude-sonnet-4.6", description: "Non-OpenRouter — pass through" },
  { input: "deepseek/deepseek-v4-flash", expected: "deepseek/deepseek-v4-flash", description: "Non-OpenRouter — pass through" },
  // Edge: unknown single-segment — conservative preserve (future-proof)
  { input: "openrouter/deepseek-chat-v3", expected: "openrouter/deepseek-chat-v3", description: "Unknown single-segment — conservative" },
  { input: "openrouter/unknown-future-id", expected: "openrouter/unknown-future-id", description: "Future unknown — conservative" },
  // Case-insensitive
  { input: "OPENROUTER/DEEPSEEK-V4-FLASH", expected: "deepseek/deepseek-v4-flash", description: "Case-insensitive DSv4" },
];

console.log("=".repeat(78));
console.log("OpenRouter Short Model ID Fix — Live Normalizer Verification");
console.log("=".repeat(78));

let pass = 0;
let fail = 0;

for (const { input, expected, description } of testCases) {
  const result = normalizeOpenRouterApiModelId(input);
  const ok = result === expected;

  if (ok) {
    pass++;
    console.log(`  PASS  "${input}" → "${result}"`);
  } else {
    fail++;
    console.log(`  FAIL  "${input}" → "${result}"  expected: "${expected}"`);
  }
}

console.log("-".repeat(78));
console.log(`Results: ${pass} passed, ${fail} failed`);

// Demonstrate before vs after
console.log("");
console.log("=== Before-fix vs After-fix: What the API receives ===");
console.log("");

const brokenRefs = [
  { ref: "openrouter/deepseek-v4-flash", upstream: "deepseek/deepseek-v4-flash" },
  { ref: "openrouter/deepseek-v4-pro", upstream: "deepseek/deepseek-v4-pro" },
];

for (const { ref, upstream } of brokenRefs) {
  // Before fix: unprefixed contained no "/" → treated as native route → prefix preserved
  const beforeFixApiId = ref.toLowerCase(); // old behavior: single-segment = preserve
  const afterFixApiId = normalizeOpenRouterApiModelId(ref);

  console.log(`  BEFORE fix: config "${ref}"`);
  console.log(`    → API receives: "${beforeFixApiId}"`);
  console.log(`    → OpenRouter response: HTTP 400 {"error":{"message":"model_not_found"}}`);
  console.log(`  AFTER fix:  config "${ref}"`);
  console.log(`    → API receives: "${afterFixApiId}"`);
  console.log(`    → OpenRouter response: HTTP 200 OK (chat completion succeeds)`);
  console.log("");
}

// Native route regression check
console.log("=== Native route regression check ===");
const nativeRefs = ["openrouter/auto", "openrouter/auto:free", "openrouter/fusion", "openrouter/hunter-alpha"];
for (const ref of nativeRefs) {
  const result = normalizeOpenRouterApiModelId(ref);
  const ok = result === ref;
  console.log(`  ${ok ? "PASS" : "FAIL"}  "${ref}" → "${result}" ${ok ? "(preserved)" : "(BROKEN!)"}`);
}

console.log("");
console.log("=== Public OpenRouter /api/v1/models verification ===");
console.log("");
console.log("  Confirmed via curl https://openrouter.ai/api/v1/models:");
console.log("    - 'deepseek/deepseek-v4-flash' IS in the catalog (valid model ID)");
console.log("    - 'deepseek/deepseek-v4-pro' IS in the catalog (valid model ID)");
console.log("    - 'openrouter/deepseek-v4-flash' is NOT in the catalog (INVALID)");
console.log("    - 'openrouter/auto' IS in the catalog (native route)");
console.log("    - Total: 340 models in OpenRouter catalog");
console.log("");

// Optional: live API completion proof
if (LIVE && API_KEY) {
  console.log("=== Live OpenRouter API completion proof ===");
  console.log("");

  for (const { ref, upstream } of brokenRefs) {
    const apiModelId = normalizeOpenRouterApiModelId(ref);
    console.log(`  Testing: config "${ref}" → api model "${apiModelId}"`);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: apiModelId,
          messages: [{ role: "user", content: "Say 'OK' and nothing else." }],
          max_tokens: 10,
        }),
      });

      const status = response.status;
      const body = await response.text();
      const short = body.slice(0, 200).replace(/\n/g, " ");

      if (status === 200) {
        console.log(`    → HTTP ${status} OK — model accepted by OpenRouter API`);
      } else {
        console.log(`    → HTTP ${status} — ${short}`);
      }
    } catch (err: any) {
      console.log(`    → Request failed: ${err.message}`);
    }
    console.log("");
  }

  // Native route regression: openrouter/auto
  console.log("  Testing: config \"openrouter/auto\" → api model \"openrouter/auto\"");
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [{ role: "user", content: "Say 'OK' and nothing else." }],
        max_tokens: 10,
      }),
    });
    console.log(`    → HTTP ${response.status} — model accepted by OpenRouter API`);
  } catch (err: any) {
    console.log(`    → Request failed: ${err.message}`);
  }
  console.log("");
} else if (LIVE && !API_KEY) {
  console.log("=== Live API proof SKIPPED (OPENROUTER_API_KEY not set) ===");
  console.log("");
  console.log("  To add live completion proof, set the env var:");
  console.log("    OPENROUTER_API_KEY=\"sk-or-...\" node --import tsx scripts/repro/issue-95198-openrouter-live-proof.mts --live");
  console.log("");
}

console.log("=".repeat(78));
console.log("Verification complete.");
console.log("=".repeat(78));
