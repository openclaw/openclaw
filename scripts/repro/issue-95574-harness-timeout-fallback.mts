// Real behavior proof for #95574: drives the production resolveRunFailoverDecision
// to verify harness-owned prompt timeout falls back when fallback is configured.
//
// Run: node --import tsx scripts/repro/issue-95574-harness-timeout-fallback.mts
import { resolveRunFailoverDecision } from "../../src/agents/embedded-agent-runner/run/failover-policy.ts";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

// Case 1: harness timeout + fallback configured -> fallback_model
const withFallback = resolveRunFailoverDecision({
  stage: "prompt",
  aborted: false,
  externalAbort: false,
  harnessOwnsTransport: true,
  fallbackConfigured: true,
  failoverFailure: true,
  failoverReason: "timeout",
  profileRotated: false,
});

if (withFallback.action !== "fallback_model") {
  fail(`expected fallback_model, got ${withFallback.action}`);
}
console.log(`PASS: harness timeout + fallback -> ${withFallback.action} (reason: ${withFallback.reason})`);

// Case 2: harness timeout + no fallback -> surface_error
const noFallback = resolveRunFailoverDecision({
  stage: "prompt",
  aborted: false,
  externalAbort: false,
  harnessOwnsTransport: true,
  fallbackConfigured: false,
  failoverFailure: true,
  failoverReason: "timeout",
  profileRotated: false,
});

if (noFallback.action !== "surface_error") {
  fail(`expected surface_error, got ${noFallback.action}`);
}
console.log(`PASS: harness timeout + no fallback -> ${noFallback.action} (reason: ${noFallback.reason})`);

// Case 3: non-harness timeout still falls back normally
const nonHarness = resolveRunFailoverDecision({
  stage: "prompt",
  aborted: false,
  externalAbort: false,
  harnessOwnsTransport: false,
  fallbackConfigured: true,
  failoverFailure: true,
  failoverReason: "timeout",
  profileRotated: false,
});

if (nonHarness.action !== "fallback_model") {
  fail(`expected fallback_model for non-harness, got ${nonHarness.action}`);
}
console.log(`PASS: non-harness timeout + fallback -> ${nonHarness.action}`);

console.log("\nALL CHECKS PASSED — harness-owned prompt timeout honors fallback config.");
