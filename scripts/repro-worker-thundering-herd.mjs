#!/usr/bin/env node
/**
 * Reproduction script: Worker reconnect thundering herd
 *
 * Simulates N workers reconnecting after a gateway restart, comparing:
 * 1. jitter: 0 (original) — all workers synchronized at every attempt
 * 2. jitter: 0.1 only — spread during exponential phase, reconverges at cap
 * 3. jitter: 0.1 + per-connection phase offset — spread preserved through cap
 *
 * Run: node scripts/repro-worker-thundering-herd.mjs
 */

const WORKER_COUNT = 20;
const ATTEMPTS = 9;
const MAX_BACKOFF_CAP_PHASE_MS = 3_000;

// Mirrors computeBackoff from packages/retry/src/index.ts
function computeBackoff(policy, attempt) {
  const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** Math.max(attempt - 1, 0));
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

const POLICY_NO_JITTER = { initialMs: 250, maxMs: 30_000, factor: 2, jitter: 0 };
const POLICY_WITH_JITTER = { initialMs: 250, maxMs: 30_000, factor: 2, jitter: 0.1 };

function simulateReconnect(policy, workerCount, attempts, usePhaseOffset) {
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    const phaseOffset = usePhaseOffset ? Math.floor(Math.random() * MAX_BACKOFF_CAP_PHASE_MS) : 0;
    let cumulativeMs = 0;
    const delays = [];
    for (let a = 1; a <= attempts; a++) {
      const backoffMs = computeBackoff(policy, a);
      // Phase offset only applies when backoff reaches the cap (matches worker-connection.ts logic)
      const cappedPhaseMs = usePhaseOffset && backoffMs >= policy.maxMs ? phaseOffset : 0;
      const delay = backoffMs + cappedPhaseMs;
      delays.push(delay);
      cumulativeMs += delay;
    }
    workers.push({ id: i, delays, totalMs: cumulativeMs });
  }
  return workers;
}

function printTimeline(label, workers, attempts) {
  console.log(`\n=== ${label} ===\n`);

  for (let a = 0; a < attempts; a++) {
    const delays = workers.map((w) => w.delays[a]);
    const unique = new Set(delays);
    const synchronized = unique.size === 1;
    const min = Math.min(...delays);
    const max = Math.max(...delays);
    console.log(
      `  Attempt ${String(a + 1).padStart(2)}: ${String(unique.size).padStart(2)} unique value(s)` +
        (synchronized
          ? ` → ⚠️  ALL ${workers.length} WORKERS AT IDENTICAL TIME (${min}ms)`
          : ` → spread ${min}–${max}ms (Δ${max - min}ms)`),
    );
  }
}

function printSummary(noJitter, jitterOnly, jitterWithPhase, attempts) {
  console.log("\n=== Summary ===\n");
  console.log("Attempt | jitter=0 | jitter=0.1 | jitter=0.1+phase");
  console.log("--------|----------|------------|------------------");
  for (let a = 0; a < attempts; a++) {
    const nj = new Set(noJitter.map((w) => w.delays[a])).size;
    const jo = new Set(jitterOnly.map((w) => w.delays[a])).size;
    const jp = new Set(jitterWithPhase.map((w) => w.delays[a])).size;
    const joDelays = jitterOnly.map((w) => w.delays[a]);
    const jpDelays = jitterWithPhase.map((w) => w.delays[a]);
    console.log(
      `  ${String(a + 1).padStart(2)}     | ${String(nj).padStart(2)} unique | ${String(jo).padStart(2)} unique (${Math.min(...joDelays)}–${Math.max(...joDelays)}ms) | ${String(jp).padStart(2)} unique (${Math.min(...jpDelays)}–${Math.max(...jpDelays)}ms)`,
    );
  }
}

console.log(`Simulating ${WORKER_COUNT} workers reconnecting after gateway restart`);
console.log(`Backoff: initialMs=250, maxMs=30000, factor=2, attempts=${ATTEMPTS}`);
console.log(`Attempts 1-6: exponential phase, attempt 7+: capped at maxMs (30s)`);

const noJitter = simulateReconnect(POLICY_NO_JITTER, WORKER_COUNT, ATTEMPTS, false);
const jitterOnly = simulateReconnect(POLICY_WITH_JITTER, WORKER_COUNT, ATTEMPTS, false);
const jitterWithPhase = simulateReconnect(POLICY_WITH_JITTER, WORKER_COUNT, ATTEMPTS, true);

printTimeline("jitter: 0 (original — THUNDERING HERD)", noJitter, ATTEMPTS);
printTimeline("jitter: 0.1 only (reconverges at cap)", jitterOnly, ATTEMPTS);
printTimeline("jitter: 0.1 + phase offset (PROPOSED FIX)", jitterWithPhase, ATTEMPTS);
printSummary(noJitter, jitterOnly, jitterWithPhase, ATTEMPTS);
