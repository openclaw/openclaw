#!/usr/bin/env node
/**
 * Live repro for PR #91373: cron sessions with string agent model configs
 * should inherit agents.defaults.model.fallbacks.
 *
 * Run: pnpm exec tsx scripts/repro/91373-cron-fallback-proof.mjs
 */
import {
  resolveCronPreflightCandidates,
  resolveCronFallbacksOverride,
} from "../../src/cron/isolated-agent/run-fallback-policy.ts";

function makeJob(payload) {
  return {
    id: "91373-proof",
    name: "Cron fallback inheritance proof",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload,
    state: {},
  };
}

const cfg = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.4",
        fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-3-pro"],
      },
    },
    list: [
      {
        id: "main",
        // This is the bug-triggering shape: a plain string model config
        // instead of an object with explicit fallbacks.
        model: "openai/gpt-5.4",
      },
    ],
  },
};

console.log("=== PR #91373 Cron fallback inheritance proof ===\n");

console.log("Config shape:");
console.log(
  '  agents.defaults.model.fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-3-pro"]',
);
console.log('  agents.list[0].model: "openai/gpt-5.4" (string, no explicit fallbacks)\n');

const fallbacksOverride = resolveCronFallbacksOverride({
  cfg,
  agentId: "main",
  job: makeJob({ kind: "agentTurn", message: "summarize" }),
});

console.log(
  "resolveCronFallbacksOverride result:",
  fallbacksOverride === undefined
    ? "undefined (will fall through to defaults)"
    : JSON.stringify(fallbacksOverride),
);

const candidates = resolveCronPreflightCandidates({
  cfg,
  agentId: "main",
  provider: "openai",
  model: "gpt-5.4",
  job: makeJob({ kind: "agentTurn", message: "summarize" }),
});

console.log("\nresolveCronPreflightCandidates result:");
for (const candidate of candidates) {
  console.log(`  - ${candidate.provider}/${candidate.model}`);
}

// The exact resolved model may vary due to alias normalization; the
// critical behavior is that the candidate chain walks the configured
// default fallbacks instead of stopping at the primary.
const hasPrimary = candidates.some((c) => c.provider === "openai" && c.model === "gpt-5.4");
const hasAnthropicFallback = candidates.some((c) => c.provider === "anthropic");
const hasGoogleFallback = candidates.some((c) => c.provider === "google");
const matches = hasPrimary && hasAnthropicFallback && hasGoogleFallback && candidates.length >= 3;

console.log("\nVerification:");
console.log(`  Primary present:     ${hasPrimary}`);
console.log(`  Anthropic fallback present: ${hasAnthropicFallback}`);
console.log(`  Google fallback present:    ${hasGoogleFallback}`);
console.log(`  Total candidates:    ${candidates.length}`);
console.log(
  matches ? "\nPASS: fallback chain inherits defaults." : "\nFAIL: fallback chain mismatch.",
);
process.exit(matches ? 0 : 1);
